import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pitch_votes')
@Unique('uq_vote_delegate_topic', ['delegateId', 'topicId'])
export class PitchVote {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column() delegateId: string;
  @Column({ type: 'uuid' })
  topicId: string;
  @Column() entryId: string;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
  /** Moves every time the delegate changes their pick - the upsert overwrites it. */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
