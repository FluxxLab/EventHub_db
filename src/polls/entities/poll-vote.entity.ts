import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One delegate's answer to one poll. The unique pair is what makes a second
 * vote a replacement rather than a duplicate: the service upserts on it.
 */
@Entity('poll_votes')
@Index('idx_poll_votes_pair', ['pollId', 'delegateId'], { unique: true })
@Index('idx_poll_votes_poll', ['pollId'])
export class PollVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pollId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'smallint' })
  optionIndex: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
