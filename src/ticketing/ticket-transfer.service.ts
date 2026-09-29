import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Not } from 'typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { Ticket } from './entities/ticket.entity';
import {
  holderNoticeText,
  isUnclaimedHolder,
  placeholderHash,
  resolveHolder,
} from './ticket-holders';
import { isOver } from './ticketing.service';

interface PreviousHolder {
  name: string;
  email: string;
  /** Their unclaimed account was removed along with its last ticket. */
  removed: boolean;
}

/**
 * Changing who a gift ticket is for. A ticket bought for someone else can be
 * passed on by its buyer until someone has been admitted on it or the event
 * is over. The new holder is found or created exactly as at settlement, and
 * the ticket's `qrVersion` goes up so the QR the previous holder may have
 * saved stops admitting. An unclaimed account left holding nothing goes.
 */
@Injectable()
export class TicketTransferService {
  private readonly logger = new Logger('TicketTransferService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
  ) {}

  /**
   * The buyer names someone else for the ticket. Refused once anyone has
   * been admitted on it, after the event, for anyone but the buyer, and to
   * the person it is already for.
   */
  async transfer(
    ticketId: string,
    buyerId: string,
    input: { name: string; email: string },
  ): Promise<void> {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (!name) throw new BadRequestException('Enter the name of the person');

    // bcrypt is slow on purpose; hash before any row is locked
    const known = await this.dataSource
      .getRepository(Delegate)
      .exists({ where: { email } });
    const hash = known ? undefined : await placeholderHash();

    const outcome = await this.dataSource.transaction(async (manager) => {
      const tickets = manager.getRepository(Ticket);
      // Locked: a scan at the gate takes the same lock, so a ticket cannot be
      // passed on in the moment someone is being let in on it.
      const ticket = await tickets.findOne({
        where: { id: ticketId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) throw new NotFoundException('Ticket not found');
      if (!ticket.purchasedBy || ticket.purchasedBy !== buyerId) {
        throw new ForbiddenException(
          'Only the person who bought this ticket can change who it is for',
        );
      }
      const used = await manager
        .getRepository(TicketAdmission)
        .count({ where: { ticketId } });
      if (used > 0) {
        throw new BadRequestException(
          'Someone has already been admitted on this ticket, so it can no longer be passed on',
        );
      }
      const edition = await this.editions.findById(ticket.editionId);
      if (isOver(edition)) {
        throw new BadRequestException(
          `${edition.name} has ended, so its tickets can no longer be passed on`,
        );
      }
      if (ticket.guestEmail.toLowerCase() === email) {
        throw new BadRequestException(`This ticket is already for ${email}`);
      }

      const delegates = manager.getRepository(Delegate);
      const holder = await resolveHolder(delegates, { name, email }, hash);
      if (holder.delegate.id === ticket.delegateId) {
        throw new BadRequestException(`This ticket is already for ${email}`);
      }
      const alreadyHolding = await tickets.exists({
        where: {
          delegateId: holder.delegate.id,
          editionId: ticket.editionId,
          id: Not(ticket.id),
        },
      });
      if (alreadyHolding) {
        throw new BadRequestException(
          `${email} already has a ticket to ${edition.name}`,
        );
      }

      const previousId = ticket.delegateId;
      const previous = { name: ticket.guestName, email: ticket.guestEmail };
      ticket.delegateId = holder.delegate.id;
      ticket.guestName = name;
      ticket.guestEmail = email;
      ticket.qrVersion = (ticket.qrVersion ?? 0) + 1;
      await tickets.save(ticket);

      const removed =
        previousId !== buyerId
          ? await this.removeIfAbandoned(manager, previousId)
          : false;
      const buyer = await delegates.findOne({ where: { id: buyerId } });
      return {
        eventName: edition.name,
        tierName: ticket.tierName,
        buyerName: buyer?.name ?? 'Someone',
        created: holder.created,
        toBuyer: holder.delegate.id === buyerId,
        previous:
          previousId !== buyerId
            ? ({ ...previous, removed } satisfies PreviousHolder)
            : null,
      };
    });

    // after the commit, and best effort: a failed email never undoes a transfer
    void this.tellAfterTransfer(name, email, outcome);
  }

  /**
   * Removes an unclaimed ticket-holder account whose last ticket has just
   * moved on: it was only ever there to hold that ticket. An account the
   * person has set up, or one still holding a ticket, stays.
   */
  private async removeIfAbandoned(
    manager: EntityManager,
    delegateId: string,
  ): Promise<boolean> {
    const account = await manager
      .getRepository(Delegate)
      .findOne({ where: { id: delegateId } });
    if (!account || !isUnclaimedHolder(account)) return false;
    const left = await manager
      .getRepository(Ticket)
      .count({ where: { delegateId } });
    if (left > 0) return false;
    await this.deleteHolderAccount(manager, delegateId);
    return true;
  }

  /**
   * An unclaimed account has never been signed in to, so it has nothing of
   * its own beyond what was addressed to it; that goes with it.
   */
  private async deleteHolderAccount(
    manager: EntityManager,
    delegateId: string,
  ): Promise<void> {
    await manager.query(
      'DELETE FROM notification_reads WHERE "delegateId" = $1',
      [delegateId],
    );
    await manager.query('DELETE FROM notifications WHERE "delegateId" = $1', [
      delegateId,
    ]);
    await manager.query('DELETE FROM device_tokens WHERE "delegateId" = $1', [
      delegateId,
    ]);
    await manager.query('DELETE FROM refresh_tokens WHERE "userId" = $1', [
      delegateId,
    ]);
    // an invite matched to them goes back to the list
    await manager.query(
      'UPDATE registration_entries SET "claimedAt" = NULL, "claimedByDelegateId" = NULL WHERE "claimedByDelegateId" = $1',
      [delegateId],
    );
    await manager.query('DELETE FROM delegates WHERE id = $1', [delegateId]);
    this.logger.log(
      `unclaimed holder account removed ${delegateId.slice(0, 8)}…`,
    );
  }

  private async tellAfterTransfer(
    name: string,
    email: string,
    outcome: {
      eventName: string;
      tierName: string;
      buyerName: string;
      created: boolean;
      toBuyer: boolean;
      previous: PreviousHolder | null;
    },
  ): Promise<void> {
    if (!outcome.toBuyer) {
      const { subject, text } = holderNoticeText(
        {
          email,
          name,
          created: outcome.created,
          buyerName: outcome.buyerName,
          tierName: outcome.tierName,
        },
        outcome.eventName,
      );
      await this.email.send(email, subject, text).catch(() => undefined);
    }
    const previous = outcome.previous;
    if (previous) {
      const text = `Hello ${previous.name},\n\n${outcome.buyerName} has passed the ${outcome.tierName} ticket to ${outcome.eventName} that was for you to someone else, so it is no longer in your name and its QR no longer admits anyone.${previous.removed ? ' The account that was made for you with it has been removed.' : ''}\n\nIf you think this is a mistake, speak to ${outcome.buyerName}.`;
      await this.email
        .send(previous.email, `Your ticket to ${outcome.eventName}`, text)
        .catch(() => undefined);
    }
  }
}
