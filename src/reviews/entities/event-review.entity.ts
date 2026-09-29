import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One delegate's review of one edition, shown on the app's event page.
 *
 * One row per pair, enforced by the unique index: reviewing again replaces
 * the earlier review, so the average is one-person-one-vote. `hidden` is the
 * console's moderation switch; a hidden review stops counting and stops
 * showing to everyone except its author.
 */
@Entity('event_reviews')
@Index('idx_event_reviews_edition', ['editionId'])
@Index('idx_event_reviews_unique', ['editionId', 'delegateId'], {
  unique: true,
})
export class EventReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  /** 1 to 5 stars; validated at the edge and by a CHECK in the database. */
  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null;

  @Column({ type: 'boolean', default: false })
  hidden: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
