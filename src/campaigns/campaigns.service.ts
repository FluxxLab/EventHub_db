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
import { StorageService } from '../common/storage/storage.service';
import { Delegate } from '../delegate/entities/delegate.entity';
import { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import { TrackingLinks } from './tracking-links';
import { UnsubscribeLinks } from './unsubscribe-links';
import {
  DEFAULT_DESIGN,
  MERGE_FIELDS,
  renderCampaign,
  unknownFields,
  type CampaignDesign,
  type CampaignRecipient,
} from './campaign-email';
import { campaignImages, type CampaignImagePart } from './campaign-images';
import {
  CAMPAIGN_IMAGE_FOLDER,
  type CampaignDesignDto,
  type SaveCampaignDto,
} from './dto/campaign.dto';
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
    private readonly storage: StorageService,
  ) {}

  /** Every campaign email carries an unsubscribe link, so none goes without the address it points at. */
  private requireLinks(): void {
    if (!this.links.consoleUrl()) {
      throw new BadRequestException(
        'Campaign emails need an unsubscribe link: set PUBLIC_CONSOLE_URL on the server to the console’s address first.',
      );
    }
  }

  /** The edition's campaigns, newest first, with the design's pictures signed for the console's preview. */
  async list(editionId: string) {
    const rows = await this.campaigns.find({
      where: { editionId },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(rows.map((c) => this.withPictures(c)));
  }

  private async withPictures<T extends { design: CampaignDesign | null }>(
    row: T,
  ) {
    const [logoUrl, bannerUrl] = await Promise.all([
      this.storage.resolveStoredUrl(row.design?.logo),
      this.storage.resolveStoredUrl(row.design?.banner),
    ]);
    return { ...row, logoUrl, bannerUrl };
  }

  /**
   * Where a new campaign's design starts: the event's own logo, cover picture
   * and brand colour (set in Events), on the PIC layout otherwise.
   */
  async eventDesign(editionId: string): Promise<CampaignDesign> {
    const edition = await this.editions.findById(editionId);
    // only pictures in our storage can be linked from an email
    const ours = (stored: string | null) =>
      stored && !/^https?:\/\//.test(stored) ? stored : null;
    return {
      ...DEFAULT_DESIGN,
      logo: ours(edition.logoImage),
      banner: ours(edition.coverImage),
      headerColor: edition.brandColor ?? DEFAULT_DESIGN.headerColor,
      buttonColor: edition.brandColor ?? DEFAULT_DESIGN.buttonColor,
    };
  }

  /** The event's design for a new campaign, with its pictures signed for the preview. */
  async designDefault(editionId: string) {
    return this.withPictures({ design: await this.eventDesign(editionId) });
  }

  /** Where the console PUTs a logo or banner (PNG, JPG or GIF) before saving the design with the key. */
  presignImage(contentType: string) {
    return this.storage.presignUpload({
      folder: CAMPAIGN_IMAGE_FOLDER,
      contentType,
    });
  }

  /** The storage key behind a picture in a campaign's emails, or null. */
  async pictureKey(
    id: string,
    part: CampaignImagePart,
  ): Promise<string | null> {
    const campaign = await this.campaigns.findOne({
      where: { id },
      select: { id: true, design: true },
    });
    return campaign?.design?.[part] ?? null;
  }

  async create(editionId: string, staffId: string, dto: SaveCampaignDto) {
    const content = this.content(dto);
    const saved = await this.campaigns.save(
      this.campaigns.create({
        editionId,
        createdBy: staffId,
        ...content,
        design:
          content.design === undefined
            ? await this.eventDesign(editionId)
            : content.design,
      }),
    );
    return this.withPictures(saved);
  }

  async update(id: string, dto: SaveCampaignDto) {
    const campaign = await this.draft(id);
    const content = this.content(dto);
    if (content.design === undefined) delete content.design;
    Object.assign(campaign, content);
    return this.withPictures(await this.campaigns.save(campaign));
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
    const edition = await this.editions.findById(campaign.editionId);
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
      null,
      await campaignImages(campaign, this.tracking, this.storage),
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
      design: dto.design === undefined ? undefined : this.design(dto.design),
      audience: {
        kind: dto.audience.kind,
        ticketTypeIds: [...new Set(dto.audience.ticketTypeIds)],
      },
    };
  }

  private design(dto: CampaignDesignDto | null): CampaignDesign | null {
    if (!dto) return null;
    return {
      logo: dto.logo || null,
      banner: dto.banner || null,
      headerColor: dto.headerColor.toLowerCase(),
      buttonColor: dto.buttonColor.toLowerCase(),
      eyebrow: dto.eyebrow.trim(),
      showEventName: dto.showEventName,
      footer: dto.footer.trim(),
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
