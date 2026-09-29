import {
  CreateDateColumn,
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One delegate's visit to one stand. The unique pair makes a repeat scan a
 * no-op rather than a second stamp, so a full passport means every stand
 * once, not one stand many times.
 */
@Entity('booth_stamps')
@Index('idx_booth_stamps_pair', ['boothId', 'delegateId'], { unique: true })
@Index('idx_booth_stamps_booth', ['boothId'])
@Index('idx_booth_stamps_delegate', ['delegateId'])
export class BoothStamp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  boothId: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
