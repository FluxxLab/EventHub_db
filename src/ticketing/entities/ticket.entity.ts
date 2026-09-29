import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An issued admission: one row per order line, carrying the quantity, as the
 * app's My Ticket tab shows them. Issued only when the order is paid.
 *
 * `code` is the human-readable reference printed on the ticket. The QR the
 * entrance gate scans is a server-signed payload (AdmissionService.qrFor),
 * not this string, so a photographed code admits nobody.
 */
@Entity('tickets')
@Index('idx_tickets_delegate', ['delegateId'])
@Index('idx_tickets_edition', ['editionId'])
@Index('idx_tickets_code', ['code'], { unique: true })
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  orderId: string;

  /** The holder: whoever walks through the gate on this ticket. */
  @Column({ type: 'uuid' })
  delegateId: string;

  /** The buyer, when they bought it for someone else; they can see it but not its QR. */
  @Index('idx_tickets_purchased_by')
  @Column({ type: 'uuid', nullable: true })
  purchasedBy: string | null;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'uuid' })
  ticketTypeId: string;

  @Column({ type: 'varchar', length: 100 })
  tierName: string;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ type: 'varchar', length: 30 })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  guestName: string;

  @Column({ type: 'varchar', length: 255 })
  guestEmail: string;

  @Column({ type: 'varchar', length: 50 })
  section: string;

  @Column({ type: 'varchar', length: 20, default: 'Open' })
  row: string;

  /**
   * Bumped whenever the buyer passes the ticket to someone else. The
   * entry QR's signature covers it, so a QR shown before the change no
   * longer admits anyone. 0 signs exactly as tickets always have.
   */
  @Column({ type: 'int', default: 0 })
  qrVersion: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
