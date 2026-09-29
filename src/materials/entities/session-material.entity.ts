import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum MaterialKind {
  SLIDES = 'slides',
  PAPER = 'paper',
  COMMUNIQUE = 'communique',
  RECORDING = 'recording',
  LINK = 'link',
  OTHER = 'other',
}

/**
 * A file or link attached to a session: the deck, the paper, the communique
 * (post-summit report, XV.3).
 *
 * `url` is either an external https link or the key handed back by
 * POST /documents/upload-url; keys are signed when the list is read, the
 * same way documents and avatars are, so the row never stores a URL that
 * expires.
 */
@Entity('session_materials')
@Index('idx_session_materials_session', ['sessionId'])
export class SessionMaterial {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  sessionId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 1000 })
  url: string;

  @Column({ type: 'enum', enum: MaterialKind, default: MaterialKind.OTHER })
  kind: MaterialKind;

  /** Shown beside the title, e.g. "2.4 MB"; the organiser types it. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  sizeLabel: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
