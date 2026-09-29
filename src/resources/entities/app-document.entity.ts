import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// A published document the app links to, keyed by a stable slug so the URL can
// be replaced without an app release. FR-15's Purple Book is the first one.
@Entity('app_documents')
export class AppDocument {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 512 })
  url: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  sizeLabel: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
