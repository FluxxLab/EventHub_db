import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { EditionsService } from '../editions/editions.service';
import { Booth } from '../passport/entities/booth.entity';
import { AdmissionService } from '../ticketing/admission.service';
import { Ticket } from '../ticketing/entities/ticket.entity';
import type { UpdateLeadDto } from './dto/leads.dto';
import { BoothLeadKey } from './entities/booth-lead-key.entity';
import { BoothLead, type LeadRating } from './entities/booth-lead.entity';

/** A lead as the exhibitor and the organisers see it. */
export interface LeadView {
  id: string;
  boothId: string;
  name: string;
  title: string | null;
  organisation: string | null;
  email: string;
  country: string | null;
  tier: string;
  note: string | null;
  rating: LeadRating | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExhibitorView {
  booth: { id: string; name: string; location: string | null };
  edition: { id: string; name: string; shortName: string };
  leads: LeadView[];
}

export interface BoothLeadSummary {
  boothId: string;
  leads: number;
  /** When the current scanner link was made; null when the booth has none. */
  linkCreatedAt: Date | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lead capture at exhibition stands. Exhibitor staff have no accounts: a
 * booth's private link carries `<booth id>.<secret>`, which the scanner page
 * sends as a header. Scanning a delegate's badge (the signed ticket QR)
 * records them as the booth's lead; it never admits anyone at the door.
 */
@Injectable()
export class LeadsService {
  constructor(
    @InjectRepository(BoothLead)
    private readonly leads: Repository<BoothLead>,
    @InjectRepository(BoothLeadKey)
    private readonly keys: Repository<BoothLeadKey>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly admission: AdmissionService,
  ) {}

  /* ------------------------------------------------------------ organisers */

  /** A new scanner link for the booth; any earlier link stops working. */
  async issueKey(boothId: string, staffId: string): Promise<{ key: string }> {
    await this.booth(boothId);
    const secret = randomBytes(24).toString('base64url');
    await this.keys.save({
      boothId,
      keyHash: sha256(secret),
      createdBy: staffId,
    });
    return { key: `${boothId}.${secret}` };
  }

  async revokeKey(boothId: string): Promise<void> {
    await this.booth(boothId);
    await this.keys.delete({ boothId });
  }

  /** Per booth: how many leads, and whether a scanner link is out. */
  async summary(editionId: string): Promise<BoothLeadSummary[]> {
    await this.editions.card(editionId);
    const rows: {
      boothId: string;
      leads: string;
      linkCreatedAt: Date | null;
    }[] = await this.dataSource.query(
      `SELECT b.id AS "boothId",
                (SELECT COUNT(*) FROM booth_leads l WHERE l."boothId" = b.id) AS leads,
                k."createdAt" AS "linkCreatedAt"
           FROM booths b
           LEFT JOIN booth_lead_keys k ON k."boothId" = b.id
          WHERE b."editionId" = $1`,
      [editionId],
    );
    return rows.map((r) => ({
      boothId: r.boothId,
      leads: Number(r.leads),
      linkCreatedAt: r.linkCreatedAt,
    }));
  }

  /** Every lead of the edition, for the organisers' export. */
  editionLeads(editionId: string): Promise<LeadView[]> {
    return this.views('l."editionId" = $1', [editionId]);
  }

  /* ------------------------------------------------------------- exhibitors */

  /** The booth a scanner link opens, or 401: the same answer for a wrong, revoked or malformed key. */
  async boothForKey(header: string | undefined): Promise<Booth> {
    const [boothId, secret] = (header ?? '').trim().split('.');
    const refuse = () =>
      new UnauthorizedException(
        'This scanner link is not valid any more. Ask the organisers for a new one.',
      );
    if (!boothId || !secret || !UUID.test(boothId)) throw refuse();
    const key = await this.keys.findOneBy({ boothId });
    const given = Buffer.from(sha256(secret));
    if (!key || !timingSafeEqual(given, Buffer.from(key.keyHash)))
      throw refuse();
    const booth = await this.dataSource
      .getRepository(Booth)
      .findOneBy({ id: boothId });
    if (!booth) throw refuse();
    return booth;
  }

  async exhibitorView(booth: Booth): Promise<ExhibitorView> {
    const edition = await this.editions.card(booth.editionId);
    return {
      booth: { id: booth.id, name: booth.name, location: booth.location },
      edition: {
        id: edition.id,
        name: edition.name,
        shortName: edition.shortName,
      },
      leads: await this.views('l."boothId" = $1', [booth.id]),
    };
  }

  /**
   * Records the delegate whose badge was scanned. The badge's QR is the
   * signed ticket payload, so a photo of someone's name, or a made-up code,
   * records nobody. A second scan of the same badge answers the lead already
   * there.
   */
  async scan(
    booth: Booth,
    qr: string,
  ): Promise<{ lead: LeadView; isNew: boolean }> {
    const ticketId = await this.admission.verify(qr);
    if (!ticketId) {
      throw new NotFoundException(
        'That is not a PIC Events badge. Scan the QR on the badge or on the ticket in the app.',
      );
    }
    const ticket = await this.dataSource
      .getRepository(Ticket)
      .findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('That ticket no longer exists');
    if (ticket.editionId !== booth.editionId) {
      throw new BadRequestException('That badge is for a different event');
    }
    const inserted = await this.leads
      .createQueryBuilder()
      .insert()
      .values({
        boothId: booth.id,
        editionId: booth.editionId,
        delegateId: ticket.delegateId,
        ticketId: ticket.id,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    const isNew = inserted.raw.length > 0;
    const [lead] = await this.views(
      'l."boothId" = $1 AND l."delegateId" = $2',
      [booth.id, ticket.delegateId],
    );
    return { lead, isNew };
  }

  async update(
    booth: Booth,
    leadId: string,
    dto: UpdateLeadDto,
  ): Promise<LeadView> {
    const lead = await this.owned(booth, leadId);
    if (dto.note !== undefined) lead.note = dto.note?.trim() || null;
    if (dto.rating !== undefined) lead.rating = dto.rating;
    await this.leads.save(lead);
    const [view] = await this.views('l.id = $1', [lead.id]);
    return view;
  }

  async remove(booth: Booth, leadId: string): Promise<void> {
    const lead = await this.owned(booth, leadId);
    await this.leads.delete({ id: lead.id });
  }

  /* ---------------------------------------------------------------- shared */

  private async owned(booth: Booth, leadId: string): Promise<BoothLead> {
    const lead = UUID.test(leadId)
      ? await this.leads.findOneBy({ id: leadId, boothId: booth.id })
      : null;
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private async booth(boothId: string): Promise<Booth> {
    const booth = await this.dataSource
      .getRepository(Booth)
      .findOneBy({ id: boothId });
    if (!booth) throw new NotFoundException('Stand not found');
    return booth;
  }

  private async views(where: string, params: unknown[]): Promise<LeadView[]> {
    const rows: LeadView[] = await this.dataSource.query(
      `SELECT l.id, l."boothId",
              COALESCE(NULLIF(d.name, ''), t."guestName") AS name,
              d.title, d.organisation,
              COALESCE(d.email, t."guestEmail") AS email,
              d.country, t."tierName" AS tier,
              l.note, l.rating, l."createdAt", l."updatedAt"
         FROM booth_leads l
         LEFT JOIN delegates d ON d.id = l."delegateId"
         LEFT JOIN tickets t ON t.id = l."ticketId"
        WHERE ${where}
        ORDER BY l."createdAt" DESC`,
      params,
    );
    return rows;
  }
}
