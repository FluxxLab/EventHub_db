import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One person let through the entrance gate on a ticket. A ticket for three
 * admits three times; each scan that lets someone in is a row here, with the
 * staff member who scanned it. Refused scans are not recorded.
 *
 * There is no time window. The gate is open whenever the event is, and a
 * delegate may arrive at any point in the day.
 */
@Entity('ticket_admissions')
@Index('idx_ticket_admissions_ticket', ['ticketId'])
@Index('idx_ticket_admissions_edition', ['editionId'])
export class TicketAdmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ticketId: string;

  @Column({ type: 'uuid' })
  editionId: string;

  /** The gate staff account that scanned it. */
  @Column({ type: 'uuid' })
  scannedBy: string;

  /**
   * When they came through. A scan made offline and uploaded later keeps the
   * time the gate phone scanned it, not the time it arrived.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  admittedAt: Date;

  /** The id the gate phone gave an offline scan, so re-uploading it admits nobody twice. */
  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  /** Which gate phone made an offline scan. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  deviceId: string | null;

  /** Set when the admission was scanned offline and uploaded afterwards. */
  @Column({ type: 'timestamptz', nullable: true })
  syncedAt: Date | null;
}
