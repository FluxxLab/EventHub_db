import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const SWITCH_KINDS = ['start_next', 'end_current'] as const;
export type SwitchKind = (typeof SWITCH_KINDS)[number];

/**
 * `open` waits for a person. `accepted`: they switched from the suggestion.
 * `matched`: they switched the same way without it (it was right).
 * `dismissed`: they said not yet (it was wrong). `expired`: the room moved on
 * some other way, or nobody answered; counted neither right nor wrong.
 */
export const SWITCH_STATUSES = [
  'open',
  'accepted',
  'matched',
  'dismissed',
  'expired',
] as const;
export type SwitchStatus = (typeof SWITCH_STATUSES)[number];

/**
 * The AI's suggestion that a room's next session has started, or its live one
 * has ended, from what the captions say. Kept after it is answered, to count
 * how often the suggestions are right.
 */
@Entity('switch_suggestions')
@Index('idx_switch_suggestion_room_status', ['room', 'status'])
export class SwitchSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  room: string;

  @Column({ type: 'varchar', length: 16 })
  kind: SwitchKind;

  /** The session live when it was suggested. */
  @Column({ type: 'uuid' })
  fromSessionId: string;

  /** The session to start, for `start_next`. */
  @Column({ type: 'uuid', nullable: true })
  toSessionId: string | null;

  @Column({ type: 'real' })
  confidence: number;

  /** The words in the captions it rests on, as said. */
  @Column({ type: 'text' })
  evidence: string;

  /** Why, in a line. */
  @Column({ type: 'varchar', length: 300 })
  reason: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status: SwitchStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;
}
