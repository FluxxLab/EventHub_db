import {
  Entity,
  CreateDateColumn,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from 'typeorm';

/** What a delegate chose to say about their gender; null means not answered. */
export const GENDERS = ['female', 'male', 'non-binary', 'undisclosed'] as const;
export type Gender = (typeof GENDERS)[number];

/** Longest profile bio, in characters; the column is varchar of this length. */
export const BIO_MAX = 280;

export enum AccessTier {
  STANDARD = 'standard',
  VIP = 'vip',
  VVIP = 'vvip',
  PRESS = 'press',
  ADMIN = 'admin',
  /**
   * Caption operators: the console shows them the Capture tab and nothing
   * else, and the API lets them publish and clear captions and nothing else.
   * A tier rather than a flag so the one RolesGuard and the one JWT claim
   * carry it without a second mechanism.
   */
  SESSION_ADMIN = 'session_admin',
  /**
   * Runs the events assigned to them (managedEditionIds) and nothing else:
   * the EditionScopeGuard checks every request against that list.
   */
  EVENT_ADMIN = 'event_admin',
}

/** Console accounts, not attendees: left out of the directory and attendee lists. */
export const STAFF_TIERS: AccessTier[] = [
  AccessTier.ADMIN,
  AccessTier.SESSION_ADMIN,
  AccessTier.EVENT_ADMIN,
];

@Entity('delegates')
export class Delegate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255, unique: true, type: 'varchar' })
  email: string;

  @Column({ length: 255, type: 'varchar', select: false })
  passwordHash: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'enum', enum: AccessTier, default: AccessTier.STANDARD })
  accessTier: AccessTier;

  @Column({ type: 'varchar', length: 100, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  track: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  organisation: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string | null;

  @Column({ default: false })
  flagged: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'text', array: true, default: '{}' })
  tags: string[];

  @Column({ type: 'boolean', default: false })
  pendingReview: boolean;

  @Column({ type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /**
   * The delegate agreed to announcements on WhatsApp, at the number above.
   * Off by default: WhatsApp requires the person's opt-in before a business
   * messages them, and the time is kept as the record of it.
   */
  @Column({ type: 'boolean', default: false })
  whatsappOptIn: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  whatsappOptInAt: Date | null;

  @Column({ type: 'text', array: true, default: '{}' })
  tracks: string[];

  @Column({ type: 'text', array: true, default: '{}' })
  interests: string[];

  @Column({ type: 'timestamptz', nullable: true })
  consentAt: Date | null;

  /**
   * False only for an account the system created on the delegate's behalf -
   * the seed importer's placeholder rows - whose password is a secret nobody
   * holds - and for an account created by Google sign-in, until the delegate
   * sets a password through reset. Password reset refuses to email a code for
   * a placeholder (a Google account is the exception: the inbox is proven).
   */
  @Column({ type: 'boolean', default: true })
  hasChosenPassword: boolean;

  @Column({ type: 'varchar', length: 20, nullable: true })
  gender: Gender | null;

  /**
   * False hides the delegate from the directory, search and edition attendee
   * lists. They still see themselves, and anyone already connected or in a
   * conversation with them still reaches them by id.
   */
  @Column({ type: 'boolean', default: true })
  directoryVisible: boolean;

  /**
   * A short "about me" for the delegate profile, capped at BIO_MAX. Shown on
   * the single-profile view only (not in bulk lists), and only while the
   * delegate is visible in the directory.
   */
  @Column({ type: 'varchar', length: 280, nullable: true })
  bio: string | null;

  /** The editions an event organiser runs; empty for everyone else. */
  @Column({ type: 'uuid', array: true, default: '{}' })
  managedEditionIds: string[];

  /**
   * The in-app tours this delegate has finished or skipped (ids such as
   * `home`, `captions`). Kept on the account rather than the phone so a
   * reinstall or a second device does not replay them. Capped server-side.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  toursSeen: string[];

  /**
   * Google's stable account id (`sub`), stored the first time the delegate
   * signs in with Google. Not selected by default: it is an identifier for
   * sign-in, not profile data.
   */
  @Index('UQ_delegates_google_sub', { unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  googleSub: string | null;
}
