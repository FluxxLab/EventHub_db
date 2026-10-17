import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What a binding names: a diarised voice (transcript.speaker) or a mic (transcript.mic). */
export const SPEAKER_NAME_KINDS = ['speaker', 'mic'] as const;
export type SpeakerNameKind = (typeof SPEAKER_NAME_KINDS)[number];

/**
 * auto: applied without anyone looking (the name matched the programme).
 * suggested: waiting for an operator. confirmed: an operator agreed, or
 * typed it. rejected: an operator said no; kept so it is not suggested again.
 */
export const SPEAKER_NAME_STATUSES = [
  'auto',
  'suggested',
  'confirmed',
  'rejected',
] as const;
export type SpeakerNameStatus = (typeof SPEAKER_NAME_STATUSES)[number];

/** Where it came from: an introduction heard live, an operator, or the whole-session review. */
export const SPEAKER_NAME_SOURCES = [
  'introduction',
  'operator',
  'review',
] as const;
export type SpeakerNameSource = (typeof SPEAKER_NAME_SOURCES)[number];

/**
 * Who a voice or a mic was, for a stretch of one session.
 *
 * Names a session's caption lines with matching kind/key that were said in
 * [fromAt, toAt), toAt null meaning still open. Only `auto` and `confirmed`
 * rows name lines; a `suggested` one waits for an operator. Voice indexes
 * restart whenever the room's stream reopens, so a 'speaker' binding never
 * outlives the run it was made in, and never names a desk's back-filled rows
 * (those were diarised separately).
 */
@Entity('speaker_names')
@Index('idx_speaker_name_session', ['sessionId'])
export class SpeakerName {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  sessionId: string;

  @Column({ type: 'enum', enum: SPEAKER_NAME_KINDS })
  kind: SpeakerNameKind;

  /** The voice index (0-based) or mic number (1-based). */
  @Column({ type: 'smallint' })
  key: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  organisation: string | null;

  /** The programme speaker this is, when it is one of them. */
  @Column({ type: 'uuid', nullable: true })
  speakerId: string | null;

  @Column({ type: 'enum', enum: SPEAKER_NAME_STATUSES })
  status: SpeakerNameStatus;

  @Column({ type: 'enum', enum: SPEAKER_NAME_SOURCES })
  source: SpeakerNameSource;

  /** The caption line it was heard in, for the operator to judge. */
  @Column({ type: 'text', nullable: true })
  evidence: string | null;

  @Column({ type: 'timestamptz' })
  fromAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  toAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** A binding as the console and the socket see it: dates as ISO strings. */
export interface SpeakerNameJson {
  id: string;
  sessionId: string;
  kind: SpeakerNameKind;
  key: number;
  name: string;
  organisation: string | null;
  speakerId: string | null;
  status: SpeakerNameStatus;
  source: SpeakerNameSource;
  evidence: string | null;
  fromAt: string;
  toAt: string | null;
  createdAt: string;
}

export function speakerNameJson(row: SpeakerName): SpeakerNameJson {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    key: row.key,
    name: row.name,
    organisation: row.organisation,
    speakerId: row.speakerId,
    status: row.status,
    source: row.source,
    evidence: row.evidence,
    fromAt: row.fromAt.toISOString(),
    toAt: row.toAt ? row.toAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
