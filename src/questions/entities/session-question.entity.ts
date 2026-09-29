import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum QuestionStatus {
  OPEN = 'open',
  ANSWERED = 'answered',
  DISMISSED = 'dismissed',
}

/**
 * A question a delegate raised from the floor during a session
 * (post-summit report, XV.1).
 *
 * `upvotes` is a denormalised counter kept in step with `question_votes` by
 * the same transaction that writes the vote row, so ranking the queue is a
 * sort on one column rather than a count per question. The vote table stays
 * the source of truth if the counter ever drifts.
 *
 * Dismissed questions are kept rather than deleted: the moderator's decision
 * is part of the session's record, and the delegate who asked can still see
 * that it was not simply lost.
 */
@Entity('session_questions')
@Index('idx_session_questions_session', ['sessionId'])
export class SessionQuestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'varchar', length: 280 })
  text: string;

  @Column({ type: 'enum', enum: QuestionStatus, default: QuestionStatus.OPEN })
  status: QuestionStatus;

  @Column({ type: 'int', default: 0 })
  upvotes: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt: Date | null;
}
