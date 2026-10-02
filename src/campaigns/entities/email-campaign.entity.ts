import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CampaignDesign } from '../campaign-email';

/** Who a campaign goes to: an edition's ticket holders, narrowed by door status and tier. */
export interface CampaignAudience {
  /** `all` ticket holders, or only those who have (or have not) come through the gate. */
  kind: 'all' | 'checked_in' | 'not_checked_in';
  /** Only these ticket tiers; empty is every tier. */
  ticketTypeIds: string[];
}

export type CampaignStatus = 'draft' | 'sending' | 'sent';

/**
 * An email to an edition's ticket holders, written in the console. A draft
 * can be edited, tested and deleted; sending snapshots the recipients into
 * `email_campaign_recipients` and a queue works through them, so a restart
 * part-way resumes where it stopped instead of emailing anyone twice.
 */
@Entity('email_campaigns')
@Index('idx_email_campaigns_edition', ['editionId'])
export class EmailCampaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  /** Plain text: blank lines make paragraphs; {{first_name}} and the like are merged per person. */
  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  buttonLabel: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  buttonUrl: string | null;

  @Column({ type: 'jsonb' })
  audience: CampaignAudience;

  /** Logo, banner, colours and header and footer text; null is the PIC layout. */
  @Column({ type: 'jsonb', nullable: true })
  design: CampaignDesign | null;

  @Column({ type: 'varchar', length: 10, default: 'draft' })
  status: CampaignStatus;

  /** Set when sending starts: how many it goes to, and how far it has got. */
  @Column({ type: 'int', default: 0 })
  recipients: number;

  @Column({ type: 'int', default: 0 })
  sent: number;

  @Column({ type: 'int', default: 0 })
  failed: number;

  /** People who opened it (once each; a click counts as an open). An estimate: some mail apps load images for everyone. */
  @Column({ type: 'int', default: 0 })
  opened: number;

  /** People who clicked a link in it, once each. */
  @Column({ type: 'int', default: 0 })
  clicked: number;

  /** Whether it went out with open and click tracking (needs PUBLIC_API_URL). */
  @Column({ type: 'boolean', default: false })
  tracked: boolean;

  @Column({ type: 'uuid' })
  createdBy: string;

  @Column({ type: 'uuid', nullable: true })
  sentBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  queuedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
