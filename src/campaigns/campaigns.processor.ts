import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import { renderCampaign } from './campaign-email';
import { CAMPAIGNS_QUEUE, type CampaignJob } from './campaigns.service';
import { CampaignRecipientRow } from './entities/campaign-recipient.entity';
import { TrackingLinks } from './tracking-links';
import { UnsubscribeLinks } from './unsubscribe-links';
import { EmailCampaign } from './entities/email-campaign.entity';

/** Emails per job: small enough that a retry repeats little, large enough not to crawl. */
export const CAMPAIGN_BATCH = 50;

/**
 * Works through a campaign's pending recipients a batch at a time. Each
 * person is marked the moment their email is handed over, so a retried or
 * resumed batch picks up only those not yet sent. A failed address is
 * recorded and skipped: one bad mailbox never holds up the rest.
 */
@Processor(CAMPAIGNS_QUEUE)
export class CampaignsProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignsProcessor.name);

  constructor(
    @InjectRepository(EmailCampaign)
    private readonly campaigns: Repository<EmailCampaign>,
    @InjectRepository(CampaignRecipientRow)
    private readonly recipients: Repository<CampaignRecipientRow>,
    private readonly editions: EditionsService,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
    @InjectQueue(CAMPAIGNS_QUEUE)
    private readonly queue: Queue<CampaignJob>,
    private readonly links: UnsubscribeLinks,
    private readonly tracking: TrackingLinks,
  ) {
    super();
  }

  async process(job: Job<CampaignJob>): Promise<void> {
    const { campaignId, batch } = job.data;
    const campaign = await this.campaigns.findOneBy({ id: campaignId });
    if (!campaign || campaign.status !== 'sending') return;
    const edition = await this.editions
      .card(campaign.editionId)
      .catch(() => null);
    const event = edition?.name ?? 'PIC Events';

    const rows = await this.recipients.find({
      where: { campaignId, status: 'pending' },
      order: { email: 'ASC' },
      take: CAMPAIGN_BATCH,
    });
    for (const row of rows) {
      const mail = renderCampaign(
        campaign,
        row,
        event,
        this.links.consoleUrl() ? this.links.pageUrl(row.email) : null,
        campaign.tracked && this.tracking.enabled()
          ? {
              pixel: this.tracking.pixelUrl(row.id),
              link: (url) => this.tracking.clickUrl(row.id, url),
            }
          : null,
      );
      try {
        await this.email.send(
          row.email,
          mail.subject,
          mail.text,
          mail.html,
          this.links.headers(row.email),
        );
        await this.recipients.update(
          { id: row.id },
          { status: 'sent', sentAt: new Date() },
        );
        await this.campaigns.increment({ id: campaignId }, 'sent', 1);
      } catch {
        await this.recipients.update({ id: row.id }, { status: 'failed' });
        await this.campaigns.increment({ id: campaignId }, 'failed', 1);
      }
    }

    if (rows.length === CAMPAIGN_BATCH) {
      await this.queue.add(
        'send-batch',
        { campaignId, batch: batch + 1 },
        {
          jobId: `campaign-${campaignId}-${batch + 1}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
      return;
    }
    await this.campaigns.update(
      { id: campaignId },
      { status: 'sent', finishedAt: new Date() },
    );
    this.logger.log(`Campaign ${campaignId} finished`);
  }
}
