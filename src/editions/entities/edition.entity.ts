import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CertificateTemplate } from '../../resources/certificate-template';
import type { BadgeDesign } from '../../ticketing/badge-design';

/**
 * Where an edition is in its life.
 *
 * Deliberately four states and not six. The console moves an edition through
 * these by hand, the way the organisers actually ran GS-26, rather than the
 * server inferring a phase from the clock: a summit that starts an hour late
 * or a registration desk that stays open through the morning should not need
 * a code change.
 */
export enum EditionStatus {
  /** Being set up. Never visible to delegates. */
  DRAFT = 'draft',
  /** Dates are public. The app shows a countdown. */
  ANNOUNCED = 'announced',
  /** The summit is happening. */
  LIVE = 'live',
  /** Over. Recordings and certificates; the app treats it as an archive. */
  ENDED = 'ended',
}

/**
 * What the raised button in the middle of the app's tab bar opens.
 *
 * A closed set, not a free URL: the app can only navigate to screens it was
 * built with, so letting the console type a destination would mean promising
 * something the client cannot keep. Each key maps to a screen, an icon and a
 * default label on the app side.
 *
 * It lives on the edition because it genuinely changes per summit. GS-26 put
 * the Innovation Hub there; the next one wants the delegate's QR pass, which
 * is the thing people actually open twenty times a day at a venue.
 */
export enum CentreAction {
  /** The signed access pass shown at a door (FR-07). */
  PASS = 'pass',
  /** Legacy spelling of PASS. Kept so an existing row keeps its meaning. */
  QR = 'qr',
  /** The networking code another delegate scans to connect. */
  CONNECT = 'connect',
  /** The camera, for scanning someone else's pass. */
  SCAN = 'scan',
  INNOVATION = 'innovation',
  NETWORKING = 'networking',
  TRIVIA = 'trivia',
  /** No button at all. The bar closes up around the gap. */
  NONE = 'none',
}

/**
 * The automatic pushes the sessions module sends on its own. Each can be
 * silenced per edition from the console: an organiser reshuffling forty
 * sessions the night before does not want forty "schedule change" buzzes
 * going to three thousand phones.
 */
/**
 * How the app files an edition on its My Events grid. The eight values are
 * the app's category tiles; a new tile is a new value here plus a migration.
 */
export enum EditionCategory {
  SUMMITS = 'summits',
  WORKSHOPS = 'workshops',
  ROUNDTABLES = 'roundtables',
  CONFERENCES = 'conferences',
  FELLOWSHIPS = 'fellowships',
  TRAINING = 'training',
  EXHIBITIONS = 'exhibitions',
  COMMUNITY = 'community',
}

export const AUTOMATIC_NOTIFICATIONS = [
  'session-created',
  'session-updated',
  'session-live',
  'session-reminder',
  /** "How was {title}?" sent when a session completes. */
  'session-feedback',
] as const;
export type AutomaticNotification = (typeof AUTOMATIC_NOTIFICATIONS)[number];

/**
 * Every app surface an edition can switch on. The app hides a tab or a
 * button whose key is missing, so a host running a summit with no polls
 * and no exhibition does not ship an empty Polls screen.
 *
 * Discussions, voting and trivia exist in the app but are off by default:
 * the post-summit report found nobody used them unless a host drove them
 * from the stage.
 */
export const EDITION_FEATURES = [
  'schedule',
  'speakers',
  'venue',
  'notifications',
  'resources',
  'captions',
  'audio',
  'questions',
  'materials',
  'feedback',
  'polls',
  'passport',
  'discussions',
  'voting',
  'trivia',
  'gallery',
  'library',
] as const;
export type EditionFeature = (typeof EDITION_FEATURES)[number];

/** What a fresh edition gets; must match the column default in the migration. */
export const DEFAULT_EDITION_FEATURES: EditionFeature[] = [
  'schedule',
  'speakers',
  'venue',
  'notifications',
  'resources',
  'captions',
  'audio',
  'questions',
  'materials',
  'feedback',
  'polls',
  'passport',
  'gallery',
  'library',
];

/**
 * What the app printed under every ticket before the terms were per edition.
 * A new edition starts with these; must match the migration's backfill.
 */
export const DEFAULT_TICKET_TERMS: string[] = [
  'Tickets are non-refundable unless the event is cancelled.',
  'Each ticket is valid for one person only.',
  'Please show your e-ticket (QR code) at the entrance.',
  'Event details may change without prior notice.',
  'Photos and videos may be used for promotion.',
];

/**
 * The practical information the app's Help screen shows: the things
 * delegates asked the desk about all day at GS-26. Free-form jsonb because
 * every summit has a different set of it; the DTO fixes the shape.
 */
export interface EditionInfo {
  wifi?: { network: string; password?: string };
  helpDesk?: {
    phone?: string;
    whatsapp?: string;
    email?: string;
    location?: string;
  };
  breaks?: {
    label: string;
    startsAt: string;
    endsAt: string;
    location?: string;
  }[];
  prayerRoom?: string;
  transport?: string;
  floorPlanUrl?: string;
  notes?: string[];
}

/**
 * One summit: GS-26, GS-27, and so on.
 *
 * The app has always assumed a summit was permanently imminent, which was true
 * for exactly one of them. An edition gives the platform a way to be between
 * summits, and gives GS-26's 204 accounts, 108 sessions and certificates
 * somewhere to live while GS-27 fills up.
 *
 * Registration is a flag rather than a status because it opens and closes
 * independently of the phase: sales can close the night before while the
 * edition is still ANNOUNCED, and can be reopened during a LIVE edition for
 * people paying at the door.
 */
@Entity('editions')
// One current edition at a time. A partial unique index rather than a check in
// application code, because two processes setting different editions current
// would both pass a read-then-write check and the database would end up with
// two. Here the second write simply fails.
@Index('idx_edition_only_one_current', ['isCurrent'], {
  unique: true,
  where: '"isCurrent" = true',
})
export class Edition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Full name, e.g. "GS-26 Gender and Inclusion Summit". */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** What people actually call it, e.g. "GS-26". Used in tight UI. */
  @Column({ type: 'varchar', length: 50 })
  shortName: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  venue: string | null;

  /** Street address for the venue page, e.g. "Plot 1, Ahmadu Bello Way". */
  @Column({ type: 'varchar', length: 255, nullable: true })
  address: string | null;

  /** One line each, printed under the edition's tickets in the app. */
  @Column({ type: 'text', array: true, default: '{}' })
  ticketTerms: string[];

  /** The app's My Events grid files the edition under this. */
  @Column({
    type: 'enum',
    enum: EditionCategory,
    default: EditionCategory.SUMMITS,
  })
  category: EditionCategory;

  /** The pin line on the app's cards, e.g. "Abuja". */
  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  /**
   * Cover artwork for the app's cards: an S3 key from an upload, or an
   * external URL. Resolved to a signed URL on the way out, like avatars.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  coverImage: string | null;

  /**
   * The event's own logo for the app's event screens: an S3 key from an
   * upload, or an external URL. Resolved to a signed URL on the way out.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  logoImage: string | null;

  /**
   * The event's button colour in the app (`#rrggbb`), or null for PIC navy.
   * The app picks white or black text on it for contrast.
   */
  @Column({ type: 'varchar', length: 7, nullable: true })
  brandColor: string | null;

  /** The paragraph on the app's details page. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Where the venue is, for the app's "nearby" sort and map pin. Both or
   * neither: the DTO refuses half a coordinate.
   */
  @Column({ type: 'double precision', nullable: true })
  latitude: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude: number | null;

  @Column({ type: 'enum', enum: EditionStatus, default: EditionStatus.DRAFT })
  status: EditionStatus;

  /** Whether tickets can be bought right now. See the class comment. */
  @Column({ type: 'boolean', default: false })
  registrationOpen: boolean;

  /** The one the app shows. At most one row may have this set. */
  @Column({ type: 'boolean', default: false })
  isCurrent: boolean;

  /** What the tab bar's centre button opens. */
  @Column({
    type: 'enum',
    enum: CentreAction,
    default: CentreAction.PASS,
  })
  centreAction: CentreAction;

  /**
   * Overrides the label under the centre button. Null means the app uses the
   * default wording for the action, which is almost always what is wanted.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  centreLabel: string | null;

  /**
   * Automatic pushes that are switched off for this edition. A text array
   * rather than four booleans so a fifth kind is one constant, not a
   * migration.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  mutedNotifications: string[];

  /**
   * The tracks this edition's programme uses: values from track_options.
   * `general` is every edition's and is not stored here.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  trackValues: string[];

  /** The interests its delegates pick from: values from interest_options. */
  @Column({ type: 'text', array: true, default: '{}' })
  interestValues: string[];

  /** Which app surfaces this edition switches on. See EDITION_FEATURES. */
  @Column({
    type: 'text',
    array: true,
    default: () => `'{${DEFAULT_EDITION_FEATURES.join(',')}}'`,
  })
  features: string[];

  /**
   * The certificate artwork and where the delegate's name and code go on it.
   * Null until the organisers upload one; certificates for this edition are
   * not available until then.
   */
  @Column({ type: 'jsonb', nullable: true })
  certificateTemplate: CertificateTemplate | null;

  /** The name badge design; null until the organisers save one. */
  @Column({ type: 'jsonb', nullable: true })
  badgeDesign: BadgeDesign | null;

  /** Help-screen content; null until the console fills it in. */
  @Column({ type: 'jsonb', nullable: true })
  info: EditionInfo | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
