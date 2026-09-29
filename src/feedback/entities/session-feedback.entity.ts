import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One delegate's rating of one session (post-summit report, XV.2).
 *
 * One row per pair, enforced by the unique index: rating again replaces the
 * earlier rating rather than adding a second voice, so the averages the
 * organisers read are one-person-one-vote. `updatedAt` records the change.
 */
@Entity('session_feedback')
@Index('idx_session_feedback_session', ['sessionId'])
@Index('idx_session_feedback_unique', ['sessionId', 'delegateId'], {
  unique: true,
})
export class SessionFeedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  /** 1 to 5 stars; the range is validated at the edge and by the database. */
  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'varchar', length: 280, nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
