import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type RecipientStatus = 'pending' | 'sent' | 'failed';

/**
 * One person a campaign goes to, snapshotted when sending starts, with what
 * is merged into their email. The queue sends `pending` rows and marks each,
 * so a retried batch never emails someone a second time.
 */
@Entity('email_campaign_recipients')
@Index('idx_campaign_recipients_pending', ['campaignId', 'status'])
@Index('uq_campaign_recipient', ['campaignId', 'email'], { unique: true })
export class CampaignRecipientRow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  campaignId: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 30 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  tier: string;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: RecipientStatus;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'int', default: 0 })
  opens: number;

  @Column({ type: 'int', default: 0 })
  clicks: number;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  clickedAt: Date | null;
}
