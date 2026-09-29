import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsModule } from '../editions/editions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsProcessor } from './campaigns.processor';
import { CAMPAIGNS_QUEUE, CampaignsService } from './campaigns.service';
import { CampaignRecipientRow } from './entities/campaign-recipient.entity';
import { EmailCampaign } from './entities/email-campaign.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { CampaignTracking } from './campaign-tracking.service';
import { CampaignLink } from './entities/campaign-link.entity';
import { TrackingController } from './tracking.controller';
import { TrackingLinks } from './tracking-links';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeLinks } from './unsubscribe-links';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EmailCampaign,
      CampaignRecipientRow,
      EmailSuppression,
      CampaignLink,
    ]),
    BullModule.registerQueue({ name: CAMPAIGNS_QUEUE }),
    EditionsModule,
    // EMAIL_SENDER: ZeptoMail, SMTP or the log, whichever is configured
    NotificationsModule,
  ],
  controllers: [CampaignsController, UnsubscribeController, TrackingController],
  providers: [
    CampaignsService,
    CampaignsProcessor,
    UnsubscribeLinks,
    TrackingLinks,
    CampaignTracking,
  ],
})
export class CampaignsModule {}
