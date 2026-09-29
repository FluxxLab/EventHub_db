import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// FR-16 certificate of participation. One per delegate per edition, issued
// once and then returned unchanged, so the code on a delegate's screen never
// shifts under them. `code` is what makes it verifiable: anyone holding it can check the
// certificate publicly without seeing the delegate's contact details.
@Entity('certificates')
@Index('idx_certificates_delegate_edition', ['delegateId', 'editionId'], {
  unique: true,
})
export class Certificate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  delegateId: string;

  /** The summit it is for; each edition issues its own, on its own artwork. */
  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  @Column({ type: 'varchar', length: 32, unique: true })
  code: string;

  // denormalised on purpose: the certificate states who it was issued to at the
  // time of issue, and must not silently change if they edit their profile later
  @Column({ type: 'varchar', length: 255 })
  delegateName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  issuedAt: Date;
}
