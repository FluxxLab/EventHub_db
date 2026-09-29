import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One topic a delegate can list on their profile to meet people about.
 *
 * `value` is what gets stored on the delegate, so it never changes once
 * created: an option is retired (isActive false) rather than renamed, and a
 * delegate who already saved a retired value keeps it.
 */
@Entity('interest_options')
export class InterestOption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60, unique: true })
  value: string;

  @Column({ type: 'varchar', length: 60 })
  label: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
