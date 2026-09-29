import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A room at an edition's venue, for the app's venue page: where it is and
 * anything worth knowing on the way. Sessions still name their room as free
 * text; the rooms list matches the two by name, ignoring case and spacing,
 * so a room can be described here without touching the programme.
 *
 * The unique index on (editionId, lower(name)) is created by the migration:
 * TypeORM cannot declare an expression index.
 */
@Entity('edition_rooms')
@Index('idx_edition_rooms_edition', ['editionId'])
export class EditionRoom {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** e.g. "Ground floor", "Level 2". */
  @Column({ type: 'varchar', length: 60, nullable: true })
  floor: string | null;

  /** e.g. "Step-free access from the east lift". */
  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
