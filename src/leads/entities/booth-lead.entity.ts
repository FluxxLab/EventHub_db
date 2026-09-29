import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** How keen a lead is, as the exhibitor judged it at the stand. */
export const LEAD_RATINGS = ['cold', 'warm', 'hot'] as const;
export type LeadRating = (typeof LEAD_RATINGS)[number];

/**
 * A delegate whose badge an exhibitor scanned at their stand. One per
 * delegate per booth: scanning the same badge again finds the lead already
 * there, with the note and rating kept.
 */
@Entity('booth_leads')
@Index('uq_booth_lead', ['boothId', 'delegateId'], { unique: true })
@Index('idx_booth_leads_edition', ['editionId'])
export class BoothLead {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  boothId: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  /** The ticket scanned, for the tier it shows. */
  @Column({ type: 'uuid' })
  ticketId: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  rating: LeadRating | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
