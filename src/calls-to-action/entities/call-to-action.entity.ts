import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** What a speaker asked for: that someone should act (a recommendation), or that they will (a pledge). */
export const CTA_TYPES = ['recommendation', 'pledge'] as const;
export type CallToActionType = (typeof CTA_TYPES)[number];

/**
 * Suggested by the analysis (or added by hand), then reviewed: only approved
 * ones go to the deck. A duplicate is merged into another and stays on record.
 */
export const CTA_STATUSES = [
  'suggested',
  'approved',
  'rejected',
  'merged',
] as const;
export type CallToActionStatus = (typeof CTA_STATUSES)[number];

/**
 * A call to action from a session: what should be done, who is called on to
 * commit to it, and who said so, with the words that prove it. The analysis
 * of a session's named transcript suggests them; organisers review every one
 * before it reaches the summit's call-to-action deck.
 */
@Entity('calls_to_action')
@Index('idx_calls_to_action_edition', ['editionId'])
@Index('idx_calls_to_action_session', ['sessionId'])
export class CallToAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  editionId: string;

  /** The session it came from; null for one added by hand without a session. */
  @Column({ type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'recommendation' })
  type: CallToActionType;

  /** What should be done, in full. */
  @Column({ type: 'text' })
  action: string;

  /** The slide's version: at most a line or two. */
  @Column({ type: 'varchar', length: 200 })
  shortText: string;

  /** Who is called on to commit: an agency, or a group such as "State governments". */
  @Column({ type: 'varchar', length: 200 })
  directedAt: string;

  /** Who said it (the name on their mic), when known. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  proposedBy: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  proposedByOrganisation: string | null;

  /** Others who asked for the same thing, gathered when duplicates are merged into this one. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  alsoProposedBy: string[];

  /** "By 2027", as said; null when no time was given. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  deadline: string | null;

  /** "₦2bn", "500 shelters", as said; null when none. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  amount: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  theme: string | null;

  /** The words it rests on, exactly as captioned. */
  @Column({ type: 'text', nullable: true })
  quote: string | null;

  /** When the quote was said, to find it in the transcript. */
  @Column({ type: 'timestamptz', nullable: true })
  saidAt: Date | null;

  /** Too vague to act on as said ("the private sector must step up"): a reviewer should sharpen or drop it. */
  @Column({ type: 'boolean', default: false })
  needsDetail: boolean;

  @Column({ type: 'varchar', length: 12, default: 'suggested' })
  status: CallToActionStatus;

  /** With status `merged`: the one it was folded into. */
  @Column({ type: 'uuid', nullable: true })
  mergedInto: string | null;

  /** `ai` from the analysis, `manual` when an organiser added it. */
  @Column({ type: 'varchar', length: 10, default: 'ai' })
  source: 'ai' | 'manual';

  /** The last organiser who changed it. */
  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
