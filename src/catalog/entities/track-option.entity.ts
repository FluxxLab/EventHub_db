import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One thematic track in the library events pick theirs from (25 Sep 2026;
 * before that the five summit tracks were a Postgres enum).
 *
 * `value` is what sessions, pitch entries, delegate profiles and editions
 * store, so it never changes once created: a track is retired (isActive
 * false) rather than renamed at the value level. `general` is not a row -
 * it is the programme bucket every event has (see GENERAL_TRACK).
 */
@Entity('track_options')
@Unique('UQ_track_options_value', ['value'])
export class TrackOption {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_track_options',
  })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  value: string;

  @Column({ type: 'varchar', length: 80 })
  label: string;

  /** One line under the track in the app's onboarding and profile pickers. */
  @Column({ type: 'varchar', length: 120, default: '' })
  hint: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
