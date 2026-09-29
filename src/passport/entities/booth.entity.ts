import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An exhibition stand a delegate can collect a stamp from. `code` is the
 * short string printed on the stand's sign or QR; scanning or typing it is
 * the stamp. Server-generated so two stands can never share one and a
 * delegate cannot guess a neighbour's from their own.
 */
@Entity('booths')
@Index('idx_booths_edition', ['editionId'])
@Index('idx_booths_code', ['code'], { unique: true })
export class Booth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 12 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  location: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /** An inactive stand keeps its stamps but no longer counts towards a full passport. */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
