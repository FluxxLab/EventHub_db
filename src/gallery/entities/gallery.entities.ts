import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** A set of an event's photos, like "Day 1" or "Opening plenary". */
@Entity('gallery_albums')
@Index('idx_gallery_albums_edition', ['editionId'])
export class GalleryAlbum {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** The photo shown on the album; the first photo when unset. */
  @Column({ type: 'uuid', nullable: true })
  coverPhotoId: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  /** Hidden from the app while organisers are still filling it. */
  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * One photo: the original and a small copy the console made at upload, so
 * the app's grid loads fast on venue wifi. Both are private storage keys,
 * signed when read.
 */
@Entity('gallery_photos')
@Index('idx_gallery_photos_album', ['albumId', 'sortOrder'])
export class GalleryPhoto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  albumId: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 255 })
  key: string;

  @Column({ type: 'varchar', length: 255 })
  thumbKey: string;

  @Column({ type: 'int' })
  width: number;

  @Column({ type: 'int' })
  height: number;

  @Column({ type: 'int' })
  sizeBytes: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  caption: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
