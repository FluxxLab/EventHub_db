import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Speaker } from './speaker.entity';

/**
 * The GS-27 summit's five thematic tracks, confirmed 22 Aug 2026, plus the
 * general bucket.
 *
 * Since 25 Sep 2026 tracks are data: a library in `track_options` that each
 * edition picks from, and the `track` columns are plain varchar. These values
 * are what the EditionTopics migration seeded; code only relies on GENERAL.
 */
export enum SessionTrack {
  DIGITAL = 'digital',
  ECONOMIC = 'economic',
  GBV = 'gbv',
  HEALTH = 'health',
  SECURITY = 'security',
  /** Not a theme — plenaries, ceremonies, breaks, registration and
   *  anything the agenda files under a programme bucket, not a track. */
  GENERAL = 'general',
}

/**
 * The bucket every edition has, whatever tracks it picks: plenaries,
 * ceremonies, breaks. Not a library row and not a theme a delegate follows,
 * so the app's track pickers leave it out.
 */
export const GENERAL_TRACK = {
  value: SessionTrack.GENERAL as string,
  label: 'General Programme',
  hint: 'Plenaries, ceremonies and breaks',
};

export enum SessionStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  COMPLETED = 'completed',
}

export interface SessionVideoLink {
  url: string;
  /** Shown above the player when a session has more than one. */
  title?: string;
}

@Entity('sessions')
@Index('idx_session_day_track', ['day', 'track'])
@Index('idx_session_status', ['status'])
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int' })
  day: number;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  /** A value from the edition's tracks (track_options), or `general`. */
  @Column({ type: 'varchar', length: 40 })
  track: string;

  @Column({
    type: 'enum',
    enum: SessionStatus,
    default: SessionStatus.SCHEDULED,
  })
  status: SessionStatus;

  @Column({ type: 'varchar', length: 255 })
  type: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  audience: string | null;

  @Column({ type: 'varchar', length: 255 })
  room: string;

  /**
   * Which summit this belongs to.
   *
   * Nullable for now: every existing row was backfilled to GS-26 by the
   * Editions migration, but nothing yet forces a new row to name an edition,
   * and a NOT NULL here would reject inserts from any code path that has not
   * been taught about editions. It becomes NOT NULL with a foreign key once
   * every writer supplies it.
   */
  @Index('idx_session_edition')
  @Column({ type: 'uuid', nullable: true })
  editionId: string | null;

  /**
   * A recording or live stream for this session, as a link.
   *
   * A URL rather than a provider id: the programme has outlived one video
   * platform already, and storing "the link the organiser was given" means
   * swapping YouTube for Vimeo later is a parser change in one file rather
   * than a migration. The client decides what it can play; anything it does
   * not recognise it offers as a link.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  videoUrl: string | null;

  /**
   * Every recording for this session, in order. A plenary split across a
   * morning and an afternoon upload is two entries; a panel with its own
   * highlights cut is two entries with titles.
   *
   * `videoUrl` above is kept in step with the first of these, because the
   * app build in the App Store reads only that field and must go on working
   * until it is replaced. New clients read this list.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  videos: SessionVideoLink[];

  @ManyToMany(() => Speaker, { cascade: false })
  @JoinTable({ name: 'session_speakers' })
  speakers: Speaker[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
