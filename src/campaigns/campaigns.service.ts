import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import { TrackingLinks } from './tracking-links';
import { UnsubscribeLinks } from './unsubscribe-links';
import {
  MERGE_FIELDS,
  renderCampaign,
  unknownFields,
  type CampaignRecipient,
} from './campaign-email';
import type { SaveCampaignDto } from './dto/campaign.dto';
import { CampaignRecipientRow } from './entities/campaign-recipient.entity';
import {
  EmailCampaign,
  type CampaignAudience,
} from './entities/email-campaign.entity';

export const CAMPAIGNS_QUEUE = 'campaigns';
/** Rows inserted per statement when a send starts. */
const INSERT_CHUNK = 1000;

export type CampaignJob = { campaignId: string; batch: number };

/**
 * Email campaigns to an edition's ticket holders. The audience is worked
 * out when sending starts, from tickets (not from who registered), so it is
 * exactly the people the door will see.
 */
@Injectable()
export class CampaignsService {
  constructor(
    @InjectRepository(EmailCampaign)
    private readonly campaigns: Repository<EmailCampaign>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
    @InjectQueue(CAMPAIGNS_QUEUE)
    private readonly queue: Queue<CampaignJob>,
    private readonly links: UnsubscribeLinks,
    private readonly tracking: TrackingLinks,
  ) {}

  /** Every campaign email carries an unsubscribe link, so none goes without the address it points at. */
  private requireLinks(): void {
    if (!this.links.consoleUrl()) {
      throw new BadRequestException(
        'Campaign emails need an unsubscribe link: set PUBLIC_CONSOLE_URL on the server to the console’s address first.',
      );
    }
  }

  list(editionId: string): Promise<EmailCampaign[]> {
    return this.campaigns.find({
      where: { editionId },
      order: { createdAt: 'DESC' },
    });
  }

  async create(
    editionId: string,
    staffId: string,
    dto: SaveCampaignDto,
  ): Promise<EmailCampaign> {
    await this.editions.card(editionId);
    return this.campaigns.save(
      this.campaigns.create({
        editionId,
        createdBy: staffId,
        ...this.content(dto),
      }),
    );
  }

  async update(id: string, dto: SaveCampaignDto): Promise<EmailCampaign> {
    const campaign = await this.draft(id);
    Object.assign(campaign, this.content(dto));
    return this.campaigns.save(campaign);
  }

  async remove(id: string): Promise<void> {
    await this.draft(id);
    await this.campaigns.delete({ id });
  }

  /** How many people an audience reaches now, and how many of it have unsubscribed (left out). */
  async audienceSize(
    editionId: string,
    audience: CampaignAudience,
  ): Promise<{ count: number; unsubscribed: number }> {
    const everyone = await this.resolve(editionId, audience, true);
    const reach = everyone.filter((p) => !p.unsubscribed).length;
    return { count: reach, unsubscribed: everyone.length - reach };
  }

  /** The draft as it would reach the person sending it, to their own inbox. */
  async sendTest(id: string, staffId: string): Promise<{ to: string }> {
    this.requireLinks();
    const campaign = await this.one(id);
    const staff = await this.dataSource
      .getRepository(Delegate)
      .findOne({ where: { id: staffId }, select: { name: true, email: true } });
    if (!staff?.email)
      throw new BadRequestException('Your account has no email address');
    const edition = await this.editions.card(campaign.editionId);
    const sample: CampaignRecipient = {
      email: staff.email,
      name: staff.name,
      code: 'PIC-GEN-TEST',
      tier: 'Sample tier',
    };
    const mail = renderCampaign(
      campaign,
      sample,
      edition.name,
      this.links.pageUrl(staff.email),
    );
    await this.email
      .send(staff.email, `[Test] ${mail.subject}`, mail.text, mail.html)
      .catch(() => {
        throw new BadRequestException(
          'The test email could not be sent. Check the email settings on the server.',
        );
      });
    return { to: staff.email };
  }

  /**
   * Starts sending: the audience is fixed now, one row per person, and the
   * queue works through them. Refused twice over for one campaign, however
   * quickly the button is pressed again.
   */
  async send(id: string, staffId: string): Promise<EmailCampaign> {
    this.requireLinks();
    const campaign = await this.draft(id);
    const people = await this.resolve(campaign.editionId, campaign.audience);
    if (people.length === 0) {
      throw new BadRequestException(
        'Nobody matches this audience yet. Choose other tiers, or everyone.',
      );
    }
    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(EmailCampaign, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.status !== 'draft') {
        throw new ConflictException('This campaign has already been sent');
      }
      for (let i = 0; i < people.length; i += INSERT_CHUNK) {
        await manager.insert(
          CampaignRecipientRow,
          people.slice(i, i + INSERT_CHUNK).map((p) => ({
            campaignId: id,
            ...p,
            status: 'pending' as const,
          })),
        );
      }
      await manager.update(
        EmailCampaign,
        { id },
        {
          status: 'sending',
          recipients: people.length,
          sentBy: staffId,
          queuedAt: new Date(),
          tracked: this.tracking.enabled(),
        },
      );
    });
    await this.queue.add(
      'send-batch',
      { campaignId: id, batch: 0 },
      {
        jobId: `campaign-${id}-0`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
    return this.one(id);
  }

  /**
   * Ticket holders of the edition matching the audience, one per email
   * address, leaving out anyone who unsubscribed (kept and marked, for the
   * count, with `withUnsubscribed`).
   */
  async resolve(
    editionId: string,
    audience: CampaignAudience,
  ): Promise<CampaignRecipient[]>;
  async resolve(
    editionId: string,
    audience: CampaignAudience,
    withUnsubscribed: true,
  ): Promise<(CampaignRecipient & { unsubscribed: boolean })[]>;
  async resolve(
    editionId: string,
    audience: CampaignAudience,
    withUnsubscribed = false,
  ): Promise<(CampaignRecipient & { unsubscribed?: boolean })[]> {
    const params: unknown[] = [editionId];
    let tiers = '';
    if (audience.ticketTypeIds.length) {
      params.push(audience.ticketTypeIds);
      tiers = `AND t."ticketTypeId" = ANY($2::uuid[])`;
    }
    const door =
      audience.kind === 'checked_in'
        ? 'HAVING BOOL_OR(a.admitted)'
        : audience.kind === 'not_checked_in'
          ? 'HAVING NOT BOOL_OR(a.admitted)'
          : '';
    const rows: (CampaignRecipient & { unsubscribed: boolean })[] =
      await this.dataSource.query(
        `SELECT * FROM (
         SELECT LOWER(COALESCE(d.email, t."guestEmail")) AS email,
              MIN(COALESCE(NULLIF(d.name, ''), t."guestName")) AS name,
              MIN(t.code) AS code,
              MIN(t."tierName") AS tier
         FROM tickets t
         LEFT JOIN delegates d ON d.id = t."delegateId"
         CROSS JOIN LATERAL (
           SELECT EXISTS (SELECT 1 FROM ticket_admissions x WHERE x."ticketId" = t.id) AS admitted
         ) a
        WHERE t."editionId" = $1 ${tiers}
        GROUP BY 1
        ${door}
        ) people
        CROSS JOIN LATERAL (
          SELECT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = people.email) AS unsubscribed
        ) u
        ORDER BY people.email`,
        params,
      );
    if (withUnsubscribed) return rows;
    return rows
      .filter((r) => !r.unsubscribed)
      .map(({ email, name, code, tier }) => ({ email, name, code, tier }));
  }

  private content(dto: SaveCampaignDto) {
    const unknown = unknownFields(
      dto.subject,
      dto.body,
      dto.buttonLabel ?? null,
    );
    if (unknown.length) {
      throw new BadRequestException(
        `There is no ${unknown.map((f) => `{{${f}}}`).join(', ')} to fill in. Use ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}.`,
      );
    }
    const label = dto.buttonLabel?.trim() || null;
    const url = dto.buttonUrl?.trim() || null;
    if (!!label !== !!url) {
      throw new BadRequestException(
        'A button needs both its words and the address it opens',
      );
    }
    return {
      subject: dto.subject.trim(),
      body: dto.body,
      buttonLabel: label,
      buttonUrl: url,
      audience: {
        kind: dto.audience.kind,
        ticketTypeIds: [...new Set(dto.audience.ticketTypeIds)],
      },
    };
  }

  async one(id: string): Promise<EmailCampaign> {
    const campaign = await this.campaigns.findOneBy({ id });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  private async draft(id: string): Promise<EmailCampaign> {
    const campaign = await this.one(id);
    if (campaign.status !== 'draft') {
      throw new ConflictException(
        'This campaign has been sent; it can no longer be changed',
      );
    }
    return campaign;
  }
}
