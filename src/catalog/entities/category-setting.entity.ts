import { Column, Entity, PrimaryColumn } from 'typeorm';
import { EditionCategory } from '../../editions/entities/edition.entity';

/**
 * How the app's My Events grid presents one EditionCategory: its tile label,
 * artwork and position. The set of categories stays the enum; this only
 * dresses them, so a missing row falls back to the built-in label.
 */
@Entity('category_settings')
export class CategorySetting {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  slug: EditionCategory;

  @Column({ type: 'varchar', length: 60 })
  label: string;

  /** An S3 key from the image-upload route, or an external URL. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  imageKey: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;
}
