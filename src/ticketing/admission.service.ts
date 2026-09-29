import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../common/storage/storage.service';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { Ticket } from './entities/ticket.entity';

/** Prefix and version of the ticket QR payload, so a scanner can tell it from a delegate link. */
const QR_PREFIX = 'PICT1';
/** 16 bytes of HMAC, base64url: forging one is out of reach, and the QR stays small. */
const SIG_LENGTH = 22;

export type AdmissionStatus = 'admitted' | 'already_used';

export interface AdmissionResult {
  /** `admitted`: let them in. `already_used`: every place on the ticket has been used. */
  status: AdmissionStatus;
  ticket: {
    id: string;
    code: string;
    tierName: string;
    section: string;
    row: string;
    quantity: number;
    guestName: string;
    ticketTypeId: string;
    edition: { id: string; name: string };
    /** The signed payload again, so a check-in desk can print the badge it scanned. */
    qr: string;
  };
  /** Who holds it, as their badge shows them; their account name wins over the checkout name. */
  holder: {
    name: string;
    title: string | null;
    organisation: string | null;
    country: string | null;
    /** A short-lived link to their profile photo, for the badge; null without one. */
    photo: string | null;
  };
  /** People let in on this ticket so far, including this scan when admitted. */
  admitted: number;
  remaining: number;
  firstAdmittedAt: Date | null;
  lastAdmittedAt: Date | null;
}

/** A ticket found at a check-in desk by code, email or name. */
export interface TicketMatch {
  ticketId: string;
  code: string;
  name: string;
  email: string;
  organisation: string | null;
  tierName: string;
  quantity: number;
  admitted: number;
  /** The signed payload: the desk admits with it, as if scanned. */
  qr: string;
}

/** Enough to pick from at a desk; a vaguer search should be narrowed. */
const MATCH_LIMIT = 8;

/**
 * What the offline gate manifest carries for a QR instead of its signature:
 * the first 128 bits of SHA-256 over the whole payload, hex. A phone can
 * check a scanned QR against it, but nobody holding the manifest can work a
 * QR back out of it (the signature alone is 132 unguessable bits), so a lost
 * gate phone leaks names, not tickets.
 */
export function qrDigest(qr: string): string {
  return createHash('sha256').update(qr.trim()).digest('hex').slice(0, 32);
}

/** Manifest format; bumped if the fields change meaning. */
export const MANIFEST_FORMAT = 1;
const MANIFEST_PAGE = 1000;

/** One ticket as an offline gate phone checks it. */
export interface ManifestTicket {
  id: string;
  /** `qrDigest` of the ticket's current QR; a QR from before a transfer does not match. */
  digest: string;
  code: string;
  /** The holder as the gate should greet them. */
  name: string;
  tierName: string;
  section: string;
  /** Places on the ticket, and how many were used when the manifest was made. */
  quantity: number;
  admitted: number;
}

export interface AdmissionManifest {
  format: number;
  editionId: string;
  editionName: string;
  generatedAt: Date;
  /** Tickets in the edition when this page was read. */
  total: number;
  tickets: ManifestTicket[];
  /**
   * Digests of QRs that were valid once and were replaced when the ticket
   * changed hands, so an offline gate can say "passed to someone else"
   * rather than "unknown".
   */
  revoked: string[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** How one offline scan fared when the gate phone uploaded it. */
export type BatchStatus =
  /** Recorded now, at the time it was scanned. */
  | 'admitted'
  /** Already uploaded earlier (a retried upload); nothing changed. */
  | 'duplicate'
  /** Every place was used elsewhere before this upload: someone got in twice. */
  | 'already_used'
  /** The QR was a previous holder's; the ticket has changed hands. */
  | 'transferred'
  /** Forged, damaged, or for a ticket that no longer exists. */
  | 'unknown'
  /** A genuine ticket for another event. */
  | 'wrong_event';

export interface BatchItemResult {
  clientId: string;
  status: BatchStatus;
  message: string;
  ticketId: string | null;
  code: string | null;
  guestName: string | null;
  quantity: number | null;
  /** People let in on the ticket after this item was handled. */
  admitted: number | null;
  lastAdmittedAt: Date | null;
}

export interface BatchItem {
  qr: string;
  scannedAt: Date;
  clientId: string;
  deviceId?: string;
}

/** Postgres unique_violation, as TypeORM's QueryFailedError carries it. */
const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505';

export interface AdmissionSummary {
  editionId: string;
  tickets: number;
  /** Places sold: the sum of ticket quantities. */
  places: number;
  /** People through the gate. */
  admitted: number;
  /** Tickets with at least one admission. */
  ticketsUsed: number;
}

/**
 * Entrance-gate admission on tickets. The QR on a ticket is signed by the
 * server, so the printed reference code alone (which a delegate may share or
 * photograph) admits nobody. Staff scan it at the door; the API checks the
 * signature, counts places left on the ticket and records who came in. No
 * time window: the door is open whenever the event is.
 */
@Injectable()
export class AdmissionService {
  constructor(
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketAdmission)
    private readonly admissions: Repository<TicketAdmission>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly config: ConfigService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  private secret(): string {
    return (
      this.config.get<string>('TICKET_QR_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  /**
   * The signature covers the ticket's `qrVersion`, which goes up each time
   * the ticket changes hands, so the QR the previous holder saved stops
   * verifying. Version 0 signs exactly as tickets always have, so QRs issued
   * before transfers existed stay valid.
   */
  private sign(ticketId: string, version = 0): string {
    const message =
      version > 0 ? `ticket:${ticketId}:${version}` : `ticket:${ticketId}`;
    return createHmac('sha256', this.secret())
      .update(message)
      .digest('base64url')
      .slice(0, SIG_LENGTH);
  }

  /** What the ticket's QR encodes: `PICT1.<ticketId>.<signature>`. */
  qrFor(ticketId: string, version = 0): string {
    return `${QR_PREFIX}.${ticketId}.${this.sign(ticketId, version)}`;
  }

  /** The ticket id and signature of a well-formed payload; null for anything else. */
  private parse(qr: string): { ticketId: string; sig: string } | null {
    const parts = qr.trim().split('.');
    if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
    const [, ticketId, sig] = parts;
    if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return null;
    return { ticketId, sig };
  }

  private signedAs(ticketId: string, sig: string, version: number): boolean {
    const expected = Buffer.from(this.sign(ticketId, version));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Throws unless `sig` is the ticket's current signature, saying so plainly when it was a previous holder's. */
  private assertCurrent(ticketId: string, sig: string, version: number): void {
    if (this.signedAs(ticketId, sig, version)) return;
    if (this.signedBefore(ticketId, sig, version)) {
      throw new BadRequestException(
        'This ticket has been passed to someone else; this QR no longer admits anyone',
      );
    }
    throw new NotFoundException('This QR is not a valid PIC Events ticket');
  }

  /** Signed for an earlier holder of the ticket: genuine, but no longer the way in. */
  private signedBefore(ticketId: string, sig: string, current: number) {
    for (let v = 0; v < current; v += 1) {
      if (this.signedAs(ticketId, sig, v)) return true;
    }
    return false;
  }

  /**
   * The ticket id from a scanned payload, or null when it is not a genuine
   * ticket QR for the ticket as it stands: forged, for a ticket that no
   * longer exists, or shown by someone the ticket has since moved away from.
   */
  async verify(qr: string): Promise<string | null> {
    const parsed = this.parse(qr);
    if (!parsed) return null;
    const ticket = await this.tickets.findOne({
      where: { id: parsed.ticketId },
      select: { id: true, qrVersion: true },
    });
    if (!ticket) return null;
    return this.signedAs(parsed.ticketId, parsed.sig, ticket.qrVersion ?? 0)
      ? parsed.ticketId
      : null;
  }

  /**
   * Admits one person on the scanned ticket. With `editionId`, a ticket for a
   * different event is refused with its event named, so the gate can redirect
   * the delegate. Concurrent scans of the same ticket are serialised on the
   * ticket row, so two gates cannot both admit the last place.
   */
  async admit(
    qr: string,
    staffId: string,
    editionId?: string,
  ): Promise<AdmissionResult> {
    const parsed = this.parse(qr);
    if (!parsed) {
      throw new NotFoundException('This QR is not a valid PIC Events ticket');
    }
    const { ticketId, sig } = parsed;

    // An unlocked look first, so a forged QR is turned away without taking a row lock.
    const known = await this.tickets.findOne({
      where: { id: ticketId },
      select: { id: true, qrVersion: true },
    });
    if (!known) {
      throw new NotFoundException(
        this.signedAs(ticketId, sig, 0)
          ? 'This ticket no longer exists'
          : 'This QR is not a valid PIC Events ticket',
      );
    }
    this.assertCurrent(ticketId, sig, known.qrVersion ?? 0);

    const outcome = await this.dataSource.transaction(async (tx) => {
      const ticket = await tx.findOne(Ticket, {
        where: { id: ticketId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) {
        throw new NotFoundException('This ticket no longer exists');
      }
      // Again under the row lock: a transfer takes the same lock, so it cannot slip in between.
      this.assertCurrent(ticketId, sig, ticket.qrVersion ?? 0);
      if (editionId && ticket.editionId !== editionId) {
        const card = await this.editions.card(ticket.editionId);
        throw new BadRequestException(`This ticket is for ${card.name}`);
      }
      const used = await tx.count(TicketAdmission, { where: { ticketId } });
      if (used >= ticket.quantity) {
        return { ticket, status: 'already_used' as const };
      }
      await tx.insert(TicketAdmission, {
        ticketId,
        editionId: ticket.editionId,
        scannedBy: staffId,
      });
      return { ticket, status: 'admitted' as const };
    });

    const { ticket, status } = outcome;
    const [card, rows, delegate] = await Promise.all([
      this.editions.card(ticket.editionId),
      this.admissions.find({
        where: { ticketId: ticket.id },
        order: { admittedAt: 'ASC' },
      }),
      this.dataSource.getRepository(Delegate).findOne({
        where: { id: ticket.delegateId },
        select: {
          id: true,
          name: true,
          title: true,
          organisation: true,
          country: true,
          avatarUrl: true,
        },
      }),
    ]);
    const photo =
      delegate?.avatarUrl && this.storage
        ? await this.storage.resolveAvatar(delegate.avatarUrl)
        : null;
    return {
      status,
      ticket: {
        id: ticket.id,
        code: ticket.code,
        tierName: ticket.tierName,
        section: ticket.section,
        row: ticket.row,
        quantity: ticket.quantity,
        guestName: ticket.guestName,
        ticketTypeId: ticket.ticketTypeId,
        edition: { id: card.id, name: card.name },
        qr: this.qrFor(ticket.id, ticket.qrVersion ?? 0),
      },
      holder: {
        name: delegate?.name || ticket.guestName,
        title: delegate?.title ?? null,
        organisation: delegate?.organisation ?? null,
        country: delegate?.country ?? null,
        photo,
      },
      admitted: rows.length,
      remaining: Math.max(0, ticket.quantity - rows.length),
      firstAdmittedAt: rows[0]?.admittedAt ?? null,
      lastAdmittedAt: rows[rows.length - 1]?.admittedAt ?? null,
    };
  }

  /** People let in on each ticket so far, and when the last one came through; for the Tickets tab. */
  async usage(
    ticketIds: string[],
  ): Promise<Map<string, { admitted: number; lastAdmittedAt: Date }>> {
    const result = new Map<
      string,
      { admitted: number; lastAdmittedAt: Date }
    >();
    if (ticketIds.length === 0) return result;
    const rows = await this.admissions
      .createQueryBuilder('a')
      .select('a.ticketId', 'ticketId')
      .addSelect('COUNT(*)::int', 'admitted')
      .addSelect('MAX(a.admittedAt)', 'lastAdmittedAt')
      .where('a.ticketId IN (:...ids)', { ids: ticketIds })
      .groupBy('a.ticketId')
      .getRawMany<{
        ticketId: string;
        admitted: number;
        lastAdmittedAt: Date;
      }>();
    for (const row of rows) {
      result.set(row.ticketId, {
        admitted: Number(row.admitted),
        lastAdmittedAt: new Date(row.lastAdmittedAt),
      });
    }
    return result;
  }

  /**
   * Tickets of the edition by what someone says at a desk: the code printed
   * on the ticket (exactly), or part of their email or name. Staff then admit
   * with the returned payload, as if it had been scanned.
   */
  async find(editionId: string, query: string): Promise<TicketMatch[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    // % and _ typed at a desk are literal, not wildcards
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('t.id', 'ticketId')
      .addSelect('t.code', 'code')
      .addSelect(`COALESCE(NULLIF(d.name, ''), t."guestName")`, 'name')
      .addSelect(`COALESCE(d.email, t."guestEmail")`, 'email')
      .addSelect('d.organisation', 'organisation')
      .addSelect('t."tierName"', 'tierName')
      .addSelect('t.quantity', 'quantity')
      .addSelect('t."qrVersion"', 'qrVersion')
      .addSelect(
        '(SELECT COUNT(*) FROM ticket_admissions a WHERE a."ticketId" = t.id)',
        'admitted',
      )
      .from('tickets', 't')
      .leftJoin('delegates', 'd', 'd.id = t."delegateId"')
      .where('t."editionId" = :editionId', { editionId })
      .andWhere(
        `(UPPER(t.code) = UPPER(:q) OR d.email ILIKE :like OR t."guestEmail" ILIKE :like OR d.name ILIKE :like OR t."guestName" ILIKE :like)`,
        { q, like },
      )
      .orderBy(`(UPPER(t.code) = UPPER(:q))`, 'DESC')
      .addOrderBy('name', 'ASC')
      .limit(MATCH_LIMIT)
      .getRawMany<Omit<TicketMatch, 'qr'> & { qrVersion: number }>();
    return rows.map(({ qrVersion, ...r }) => ({
      ...r,
      quantity: Number(r.quantity),
      admitted: Number(r.admitted),
      qr: this.qrFor(r.ticketId, Number(qrVersion ?? 0)),
    }));
  }

  /**
   * One page of the offline gate manifest: every ticket of the edition with
   * a digest of its current QR (never the signature, never the key), the
   * holder's name, tier and places used so far. A gate phone downloads it
   * while it has signal and checks scans against it when it has none.
   * Keyset-paged on the ticket id so ~3,000 tickets come in a few requests.
   */
  async manifest(
    editionId: string,
    cursor?: string,
    limit = MANIFEST_PAGE,
  ): Promise<AdmissionManifest> {
    const size = Math.min(Math.max(1, limit), 2000);
    // 404 for an edition that does not exist; its name heads the gate screen
    const card = await this.editions.card(editionId);
    const generatedAt = new Date();
    const query = this.dataSource
      .createQueryBuilder()
      .select('t.id', 'id')
      .addSelect('t.code', 'code')
      .addSelect(`COALESCE(NULLIF(d.name, ''), t."guestName")`, 'name')
      .addSelect('t."tierName"', 'tierName')
      .addSelect('t.section', 'section')
      .addSelect('t.quantity', 'quantity')
      .addSelect('t."qrVersion"', 'qrVersion')
      .addSelect(
        '(SELECT COUNT(*) FROM ticket_admissions a WHERE a."ticketId" = t.id)',
        'admitted',
      )
      .from('tickets', 't')
      .leftJoin('delegates', 'd', 'd.id = t."delegateId"')
      .where('t."editionId" = :editionId', { editionId });
    if (cursor) query.andWhere('t.id > :cursor', { cursor });
    const [rows, total] = await Promise.all([
      query
        .orderBy('t.id', 'ASC')
        .limit(size + 1)
        .getRawMany<{
          id: string;
          code: string;
          name: string;
          tierName: string;
          section: string;
          quantity: number | string;
          qrVersion: number | string | null;
          admitted: number | string;
        }>(),
      this.tickets.count({ where: { editionId } }),
    ]);
    const page = rows.slice(0, size);
    const revoked: string[] = [];
    const tickets = page.map((row) => {
      const version = Number(row.qrVersion ?? 0);
      for (let v = 0; v < version; v += 1)
        revoked.push(qrDigest(this.qrFor(row.id, v)));
      return {
        id: row.id,
        digest: qrDigest(this.qrFor(row.id, version)),
        code: row.code,
        name: row.name,
        tierName: row.tierName,
        section: row.section,
        quantity: Number(row.quantity),
        admitted: Number(row.admitted),
      };
    });
    return {
      format: MANIFEST_FORMAT,
      editionId,
      editionName: card.name,
      generatedAt,
      total,
      tickets,
      revoked,
      nextCursor: rows.length > size ? page[page.length - 1].id : null,
    };
  }

  /**
   * Admissions a gate phone made offline, uploaded when it is back online.
   * Each is admitted as if scanned at `scannedAt`, oldest first, so two
   * scans of one ticket count in the order they happened. Nothing is thrown
   * per item: each comes back with what happened, and the conflicts (let in
   * on a ticket already used elsewhere, a previous holder's QR, another
   * event's ticket) are for the gate to show staff. Safe to re-send: an item
   * already uploaded reports `duplicate` and admits nobody again.
   */
  async admitBatch(
    items: BatchItem[],
    staffId: string,
    editionId: string,
  ): Promise<{ results: BatchItemResult[]; summary: AdmissionSummary }> {
    const ordered = [...items].sort(
      (a, b) => a.scannedAt.getTime() - b.scannedAt.getTime(),
    );
    const results: BatchItemResult[] = [];
    for (const item of ordered) {
      results.push(await this.admitOffline(item, staffId, editionId));
    }
    return { results, summary: await this.summary(editionId) };
  }

  private async admitOffline(
    item: BatchItem,
    staffId: string,
    editionId: string,
  ): Promise<BatchItemResult> {
    const parsed = this.parse(item.qr);
    if (!parsed) {
      return this.itemResult(
        item,
        'unknown',
        'This QR is not a valid PIC Events ticket',
        null,
      );
    }
    // Uploaded before and the answer was lost on the way back.
    const earlier = await this.admissions.findOne({
      where: { clientId: item.clientId },
    });
    if (earlier) return this.replayed(item, earlier.ticketId);

    const now = new Date();
    // a phone clock running ahead cannot put an admission in the future
    const admittedAt = item.scannedAt > now ? now : item.scannedAt;
    let outcome: { status: BatchStatus; ticket: Ticket | null };
    try {
      outcome = await this.dataSource.transaction(async (tx) => {
        const ticket = await tx.findOne(Ticket, {
          where: { id: parsed.ticketId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!ticket) return { status: 'unknown' as const, ticket: null };
        const version = ticket.qrVersion ?? 0;
        if (!this.signedAs(ticket.id, parsed.sig, version)) {
          // a previous holder's QR is named as such; a forgery learns nothing about the ticket
          return this.signedBefore(ticket.id, parsed.sig, version)
            ? { status: 'transferred' as const, ticket }
            : { status: 'unknown' as const, ticket: null };
        }
        if (ticket.editionId !== editionId)
          return { status: 'wrong_event' as const, ticket };
        const used = await tx.count(TicketAdmission, {
          where: { ticketId: ticket.id },
        });
        if (used >= ticket.quantity)
          return { status: 'already_used' as const, ticket };
        await tx.insert(TicketAdmission, {
          ticketId: ticket.id,
          editionId: ticket.editionId,
          scannedBy: staffId,
          admittedAt,
          clientId: item.clientId,
          deviceId: item.deviceId ?? null,
          syncedAt: now,
        });
        return { status: 'admitted' as const, ticket };
      });
    } catch (error) {
      // the same upload arrived twice at once; the other copy recorded it
      if (!isUniqueViolation(error)) throw error;
      return this.replayed(item, parsed.ticketId);
    }

    const { status, ticket } = outcome;
    switch (status) {
      case 'admitted':
        return this.itemResult(item, status, 'Admitted', ticket);
      case 'already_used':
        return this.itemResult(
          item,
          status,
          'Every place on this ticket was used at another gate before this scan was uploaded',
          ticket,
        );
      case 'transferred':
        return this.itemResult(
          item,
          status,
          "This ticket has been passed to someone else; the QR scanned was the previous holder's",
          // another event's ticket stays anonymous to this gate
          ticket?.editionId === editionId ? ticket : null,
        );
      case 'wrong_event': {
        const other = await this.editions
          .card(ticket!.editionId)
          .catch(() => null);
        return this.itemResult(
          item,
          status,
          other
            ? `This ticket is for ${other.name}`
            : 'This ticket is for another event',
          null,
        );
      }
      default:
        return this.itemResult(
          item,
          'unknown',
          'This QR is not a valid PIC Events ticket',
          null,
        );
    }
  }

  private async replayed(
    item: BatchItem,
    ticketId: string,
  ): Promise<BatchItemResult> {
    const ticket = await this.tickets.findOne({ where: { id: ticketId } });
    return this.itemResult(item, 'duplicate', 'Already uploaded', ticket);
  }

  private async itemResult(
    item: BatchItem,
    status: BatchStatus,
    message: string,
    ticket: Ticket | null,
  ): Promise<BatchItemResult> {
    const usage = ticket
      ? (await this.usage([ticket.id])).get(ticket.id)
      : undefined;
    return {
      clientId: item.clientId,
      status,
      message,
      ticketId: ticket?.id ?? null,
      code: ticket?.code ?? null,
      guestName: ticket?.guestName ?? null,
      quantity: ticket?.quantity ?? null,
      admitted: ticket ? (usage?.admitted ?? 0) : null,
      lastAdmittedAt: usage?.lastAdmittedAt ?? null,
    };
  }

  /** Gate numbers for one edition, for the console and the gate screen. */
  async summary(editionId: string): Promise<AdmissionSummary> {
    const [totals, admitted] = await Promise.all([
      this.tickets
        .createQueryBuilder('t')
        .select('COUNT(*)::int', 'tickets')
        .addSelect('COALESCE(SUM(t.quantity), 0)::int', 'places')
        .where('t.editionId = :editionId', { editionId })
        .getRawOne<{ tickets: number; places: number }>(),
      this.admissions
        .createQueryBuilder('a')
        .select('COUNT(*)::int', 'admitted')
        .addSelect('COUNT(DISTINCT a.ticketId)::int', 'ticketsUsed')
        .where('a.editionId = :editionId', { editionId })
        .getRawOne<{ admitted: number; ticketsUsed: number }>(),
    ]);
    return {
      editionId,
      tickets: Number(totals?.tickets ?? 0),
      places: Number(totals?.places ?? 0),
      admitted: Number(admitted?.admitted ?? 0),
      ticketsUsed: Number(admitted?.ticketsUsed ?? 0),
    };
  }
}
