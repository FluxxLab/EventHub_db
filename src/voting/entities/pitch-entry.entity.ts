import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PitchTopic } from './pitch-topic.entity';

@Entity('pitch_entries')
export class PitchEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  innovatorName: string;

  @Column({ type: 'varchar', length: 100 })
  country: string;

  /** A value from the track library (track_options), or `general`. */
  @Column({ type: 'varchar', length: 40 })
  track: string;

  @Column({ type: 'text' })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'uuid' })
  topicId: string;

  @ManyToOne(() => PitchTopic, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'topicId' })
  topic: PitchTopic;
}
