import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One tier of admission to an edition: Standard, VIP, Press and so on.
 *
 * Prices are whole naira. A null price is "by invitation": the tier is shown
 * on the app's pricing tab but cannot be bought; the registration list grants
 * it. Zero is free and buyable. Capacity null means unlimited.
 */
@Entity('ticket_types')
@Index('idx_ticket_types_edition', ['editionId'])
export class TicketType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Whole naira; kept in step with `prices.NGN`. Null means by invitation. */
  @Column({ type: 'int', nullable: true })
  price: number | null;

  /**
   * Price per currency, whole units, entered by the organiser rather than
   * converted live: a rate that moves between quote and charge makes odd
   * figures and messy refunds. NGN is required for a buyable tier; a
   * currency with no entry falls back to USD, then NGN.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  prices: Record<string, number>;

  @Column({ type: 'text', array: true, default: '{}' })
  perks: string[];

  /** Printed on the ticket, e.g. "VIP", "General". */
  @Column({ type: 'varchar', length: 50, default: 'General' })
  section: string;

  @Column({ type: 'int', nullable: true })
  capacity: number | null;

  @Column({ type: 'int', default: 0 })
  sold: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
