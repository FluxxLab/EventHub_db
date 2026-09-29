import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One plate handed over. `seat` counts up to the ticket's quantity, and the
 * unique index on (meal, ticket, seat) is what makes a second scan of the
 * same ticket for the same meal fail, even when two counters scan it at the
 * same moment.
 */
@Entity('meal_servings')
@Index('uq_meal_servings_seat', ['mealId', 'ticketId', 'seat'], {
  unique: true,
})
export class MealServing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  mealId: string;

  @Column({ type: 'uuid' })
  ticketId: string;

  @Column({ type: 'int', default: 1 })
  seat: number;

  @Column({ type: 'uuid', nullable: true })
  counterId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  servedAt: Date;
}
