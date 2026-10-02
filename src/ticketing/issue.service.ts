import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { AccessTier, Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import type { IssueTicketsDto } from './dto/issue.dto';
import { Order, OrderStatus } from './entities/order.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { uniqueTicketCode } from './ticket-code';
import { TICKET_HOLDER_TAG } from './ticket-holders';

/** Marks the orders behind issued tickets, so they read apart from sales. */
export const ISSUED_PROVIDER = 'issued';

export type IssueSkipReason = 'has_ticket' | 'duplicate';

export interface IssueResult {
  issued: {
    email: string;
    name: string;
    code: string;
    ticketId: string;
    /** An account was created for them, waiting to be claimed. */
    created: boolean;
  }[];
  skipped: { email: string; reason: IssueSkipReason }[];
}

const clean = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * Tickets issued by the organisers, without payment: an attendee list
 * brought over from another platform, speakers and guests, a walk-in at the
 * desk. Each call is one free order in the issuing staff member's name, so
 * revenue is untouched and who issued what stays on record. Holders get
 * accounts the way gift tickets do: an existing account by email, otherwise
 * one created unclaimed. Someone who already holds a ticket to the edition
 * is skipped, never given a second.
 */
@Injectable()
export class IssueService {
  private readonly logger = new Logger('IssueService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
  ) {}

  async issue(
    editionId: string,
    staffId: string,
    dto: IssueTicketsDto,
  ): Promise<IssueResult> {
    const edition = await this.editions.findById(editionId);
    const skipped: IssueResult['skipped'] = [];

    // one ticket per person in the request
    const seen = new Set<string>();
    const rows = dto.rows
      .map((r) => ({
        name: r.name.trim(),
        email: r.email.trim().toLowerCase(),
        ticketTypeId: r.ticketTypeId,
        organisation: clean(r.organisation),
        title: clean(r.title),
        country: clean(r.country),
      }))
      .filter((r) => {
        if (!r.name) throw new BadRequestException('Every row needs a name');
        if (seen.has(r.email)) {
          skipped.push({ email: r.email, reason: 'duplicate' });
          return false;
        }
        seen.add(r.email);
        return true;
      });

    const types = await this.dataSource
      .getRepository(TicketType)
      .find({ where: { editionId } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    const unknown = rows.find((r) => !typeById.has(r.ticketTypeId));
    if (unknown) {
      throw new BadRequestException(
        `${unknown.email}: that ticket tier is not one of ${edition.name}'s`,
      );
    }

    // already holding a ticket to this edition, under the account or the name on the ticket
    const emails = rows.map((r) => r.email);
    const holding = emails.length
      ? await this.dataSource
          .createQueryBuilder()
          .select('LOWER(d.email)', 'account')
          .addSelect('LOWER(t."guestEmail")', 'guest')
          .from('tickets', 't')
          .leftJoin('delegates', 'd', 'd.id = t."delegateId"')
          .where('t."editionId" = :editionId', { editionId })
          .andWhere(
            '(LOWER(d.email) IN (:...emails) OR LOWER(t."guestEmail") IN (:...emails))',
            { emails },
          )
          .getRawMany<{ account: string | null; guest: string | null }>()
      : [];
    const held = new Set(holding.flatMap((h) => [h.account, h.guest]));
    const toIssue = rows.filter((r) => {
      if (!held.has(r.email)) return true;
      skipped.push({ email: r.email, reason: 'has_ticket' });
      return false;
    });
    if (toIssue.length === 0) return { issued: [], skipped };

    // Accounts to create get a password nobody knows. It is 32 random bytes,
    // so bcrypt's work factor adds nothing; a low one keeps a 500-row import
    // to milliseconds instead of a minute. Claiming the account replaces it.
    const known = new Set(
      (
        await this.dataSource.getRepository(Delegate).find({
          where: { email: In(toIssue.map((r) => r.email)) },
          select: { email: true },
        })
      ).map((d) => d.email.toLowerCase()),
    );
    const hashes = new Map<string, string>();
    for (const r of toIssue.filter((r) => !known.has(r.email))) {
      hashes.set(
        r.email,
        await bcrypt.hash(randomBytes(32).toString('hex'), 4),
      );
    }

    const staff = await this.dataSource
      .getRepository(Delegate)
      .findOne({ where: { id: staffId } });

    const issued: IssueResult['issued'] = [];
    await this.dataSource.transaction(async (manager) => {
      const typeRepo = manager.getRepository(TicketType);
      const tickets = manager.getRepository(Ticket);
      const delegates = manager.getRepository(Delegate);

      // places, checked and taken under the tier's lock like a sale
      const perType = new Map<string, number>();
      for (const r of toIssue) {
        perType.set(r.ticketTypeId, (perType.get(r.ticketTypeId) ?? 0) + 1);
      }
      const locked = new Map<string, TicketType>();
      for (const [id, count] of perType) {
        const type = await typeRepo.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!type) throw new BadRequestException('A ticket tier was removed');
        if (type.capacity !== null && type.sold + count > type.capacity) {
          const left = Math.max(0, type.capacity - type.sold);
          throw new BadRequestException(
            `${type.name} has ${left} ${left === 1 ? 'place' : 'places'} left and this would issue ${count}. Raise its capacity or move some people to another tier.`,
          );
        }
        type.sold += count;
        await typeRepo.save(type);
        locked.set(id, type);
      }

      const order = await manager.getRepository(Order).save(
        manager.getRepository(Order).create({
          delegateId: staffId,
          editionId,
          status: OrderStatus.PAID,
          lines: [...perType].map(([id, quantity]) => ({
            ticketTypeId: id,
            name: locked.get(id)!.name,
            quantity,
            unitPrice: 0,
          })),
          adminFee: 0,
          voucherCode: null,
          discount: 0,
          total: 0,
          attendees: toIssue.map((r) => ({
            ticketTypeId: r.ticketTypeId,
            name: r.name,
            email: r.email,
          })),
          currency: 'NGN',
          country: null,
          guestName: staff?.name ?? 'Organisers',
          guestEmail: staff?.email ?? 'organisers@pic.events',
          guestPhone: null,
          paymentMethod: null,
          provider: ISSUED_PROVIDER,
          providerRef: `${ISSUED_PROVIDER}:${randomUUID()}`,
          paidAt: new Date(),
        }),
      );

      for (const r of toIssue) {
        const type = locked.get(r.ticketTypeId)!;
        let delegate = await delegates.findOne({ where: { email: r.email } });
        const created = !delegate;
        if (!delegate) {
          delegate = await delegates.save(
            delegates.create({
              name: r.name,
              email: r.email,
              passwordHash: hashes.get(r.email)!,
              accessTier: AccessTier.STANDARD,
              pendingReview: false,
              hasChosenPassword: false,
              consentAt: null,
              tags: [TICKET_HOLDER_TAG],
              phone: null,
              avatarUrl: null,
              interests: [],
              tracks: [],
              organisation: r.organisation,
              title: r.title,
              country: r.country,
            }),
          );
        } else if (
          (!delegate.organisation && r.organisation) ||
          (!delegate.title && r.title) ||
          (!delegate.country && r.country)
        ) {
          // fill gaps only: what someone wrote on their own profile stays
          await delegates.update(
            { id: delegate.id },
            {
              organisation: delegate.organisation ?? r.organisation,
              title: delegate.title ?? r.title,
              country: delegate.country ?? r.country,
            },
          );
        }
        const ticket = await tickets.save(
          tickets.create({
            orderId: order.id,
            delegateId: delegate.id,
            purchasedBy: null,
            editionId,
            ticketTypeId: type.id,
            tierName: type.name,
            quantity: 1,
            code: await uniqueTicketCode(tickets, type.section),
            guestName: r.name,
            guestEmail: r.email,
            section: type.section,
            row: 'Open',
          }),
        );
        issued.push({
          email: r.email,
          name: r.name,
          code: ticket.code,
          ticketId: ticket.id,
          created,
        });
      }
    });

    if (dto.notify) {
      const tier = new Map(
        toIssue.map((r) => [r.email, typeById.get(r.ticketTypeId)!.name]),
      );
      void this.tell(edition.name, issued, tier);
    }
    return { issued, skipped };
  }

  /** "You have a ticket." Best effort and after the response: a failed email never undoes a ticket. */
  private async tell(
    eventName: string,
    issued: IssueResult['issued'],
    tier: Map<string, string>,
  ): Promise<void> {
    let failed = 0;
    for (const t of issued) {
      const how = t.created
        ? `Download PIC Events and sign up with this email address (${t.email}) to see your ticket and entry QR. Your account is already waiting for you.`
        : `Open PIC Events and sign in with ${t.email} to see your ticket and entry QR under Tickets.`;
      const text = `Hello ${t.name},\n\nThe organisers of ${eventName} have issued you a ${tier.get(t.email) ?? ''} ticket (${t.code}).\n\n${how}\n\nShow the QR, or your printed badge, at the entrance. If you were not expecting this, you can ignore this email.`;
      await this.email
        .send(t.email, `Your ticket to ${eventName}`, text)
        .catch(() => (failed += 1));
    }
    if (failed) {
      this.logger.warn(`${failed} of ${issued.length} ticket emails failed`);
    }
  }
}
