import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A food counter and the private link its catering staff scan with. Only the
 * link secret's SHA-256 is kept: organisers see the link once when it is made,
 * and making a new one revokes the old. No key means the link is switched off.
 */
@Entity('meal_counters')
@Index('idx_meal_counters_edition', ['editionId'])
export class MealCounter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  keyHash: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
