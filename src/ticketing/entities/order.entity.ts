import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OrderStatus {
  PENDING = 'pending',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

import type { OrderAttendee } from '../ticket-holders';

/** A priced line, snapshotted at order time so a later price change never re-bills anyone. */
export interface OrderLineSnapshot {
  ticketTypeId: string;
  name: string;
  quantity: number;
  /** Whole naira per ticket at the time of the order. */
  unitPrice: number;
}

/**
 * A delegate's purchase of tickets for one edition. The money figures are
 * computed here and only here; the app renders them (TR-02). Lines are a
 * snapshot in jsonb: an order is a receipt, and a receipt does not change
 * when the price list does.
 */
@Entity('orders')
@Index('idx_orders_delegate', ['delegateId'])
@Index('idx_orders_edition', ['editionId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  lines: OrderLineSnapshot[];

  @Column({ type: 'int', default: 0 })
  adminFee: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  voucherCode: string | null;

  @Column({ type: 'int', default: 0 })
  discount: number;

  /** Tickets plus fee minus discount; what the provider is asked to charge. */
  @Column({ type: 'int', default: 0 })
  total: number;

  /**
   * Who each place is for, named at checkout. Empty on orders from older app
   * builds: those issue one ticket per line to the buyer, as before.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  attendees: OrderAttendee[];

  /** Every figure on this order is in this currency, and so is the receipt. */
  @Column({ type: 'varchar', length: 3, default: 'NGN' })
  currency: string;

  /** Billing country the delegate chose; decides currency, provider and methods. */
  @Column({ type: 'varchar', length: 2, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 255 })
  guestName: string;

  @Column({ type: 'varchar', length: 255 })
  guestEmail: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  guestPhone: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  paymentMethod: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerRef: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
