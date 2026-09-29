import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The secret behind a booth's lead-scanner link. Only its SHA-256 is kept,
 * so the link cannot be read back from the database; the organisers see it
 * once when it is made, and making a new one replaces (revokes) the old.
 */
@Entity('booth_lead_keys')
export class BoothLeadKey {
  @PrimaryColumn({ type: 'uuid' })
  boothId: string;

  @Column({ type: 'varchar', length: 64 })
  keyHash: string;

  @Column({ type: 'uuid' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
