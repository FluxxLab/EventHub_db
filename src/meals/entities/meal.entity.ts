import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** A meal an event serves, such as "Lunch, Day 1", with the window it is served in. */
@Entity('meals')
@Index('idx_meals_edition', ['editionId'])
export class Meal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Counters can serve it from this moment... */
  @Column({ type: 'timestamptz' })
  startsAt: Date;

  /** ...until this one. */
  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
