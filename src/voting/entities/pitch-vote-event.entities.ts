import {
  PrimaryGeneratedColumn,
  Entity,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('pitch_vote_events')
@Index(['topicId', 'at'])
export class PitchVoteEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() delegateId: string;
  @Column() topicId: string;
  @Column() entryId: string;
  @Column({ type: 'uuid', nullable: true }) previousEntryId: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) at: Date;
}
