import { Column, Entity, PrimaryColumn } from 'typeorm';

/** How often each link in a campaign was clicked, for the campaign's report. */
@Entity('email_campaign_links')
export class CampaignLink {
  @PrimaryColumn({ type: 'uuid' })
  campaignId: string;

  @PrimaryColumn({ type: 'varchar', length: 500 })
  url: string;

  @Column({ type: 'int', default: 0 })
  clicks: number;
}
