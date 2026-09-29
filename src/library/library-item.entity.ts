import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** What a resource is: a file to read, something to watch or listen to, or a page elsewhere. */
export const LIBRARY_KINDS = ['document', 'video', 'audio', 'link'] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/**
 * A learning resource for an edition's delegates: a report, a toolkit, a
 * recording, a course elsewhere. Files live in private storage under
 * `library/<edition>/` (signed when read); videos and pages are links.
 */
@Entity('library_items')
@Index('idx_library_items_edition', ['editionId', 'sortOrder'])
export class LibraryItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 10 })
  kind: LibraryKind;

  /** A storage key for an uploaded file, or an https address. */
  @Column({ type: 'varchar', length: 1000 })
  url: string;

  /** Groups resources in the app, like "Gender budgeting" or "Toolkits". */
  @Column({ type: 'varchar', length: 80, nullable: true })
  topic: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  sizeLabel: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
