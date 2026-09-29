import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** A percentage off the ticket lines. Scoped to an edition, or global when editionId is null. */
@Entity('vouchers')
export class Voucher {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  code: string;

  @Column({ type: 'int' })
  percentOff: number;

  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'int', nullable: true })
  maxUses: number | null;

  @Column({ type: 'int', default: 0 })
  uses: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
