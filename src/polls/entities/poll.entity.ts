import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum PollStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  CLOSED = 'closed',
}

/**
 * A question fired from the stage with two to six answers, which the room
 * answers on their phones. One is open at a time per edition, like trivia:
 * the MC reads out one thing, the screen shows one thing.
 *
 * `options` is a JSON array rather than a child table because a poll is
 * authored once and never edited after opening; the vote stores the index.
 */
@Entity('polls')
@Index('idx_polls_edition', ['editionId'])
export class Poll {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  /** Set when the poll belongs to one session's segment; informational only. */
  @Column({ type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 200 })
  question: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  options: string[];

  @Column({ type: 'enum', enum: PollStatus, default: PollStatus.DRAFT })
  status: PollStatus;

  /**
   * Whether delegates see the tally while the poll is open. Off for a
   * "guess the number" style question where an early lead would anchor the
   * room; results are always visible once the poll closes.
   */
  @Column({ type: 'boolean', default: true })
  showResults: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
