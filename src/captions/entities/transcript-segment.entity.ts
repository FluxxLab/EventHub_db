import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum TranscriptSource {
  AI = 'ai',
  HUMAN = 'human',
}

@Entity('transcript_segments')
export class TranscriptSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  sessionId: string;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'varchar', length: 255 })
  room: string;

  /**
   * Which language this row is in - 'en' for the Deepgram transcript, and one
   * row per translation of it.
   *
   * Translations used to be broadcast and thrown away, which meant a delegate
   * joining a session late could only ever be shown English history. Persisting
   * them lets any language be backfilled, survives a socket reconnect, and
   * makes translated transcripts exportable like the English one.
   */
  @Column({ type: 'varchar', length: 8, default: 'en' })
  language: string;

  /**
   * The English row this is a translation of. Null on the English row itself.
   *
   * Kept so a translation can be traced to its source - useful when a
   * translation reads oddly and someone needs to see what was actually said.
   */
  @Column({ type: 'uuid', nullable: true })
  sourceSegmentId: string | null;

  /**
   * Diarised voice index from the transcription provider, 0-based. Nullable:
   * a provider that cannot attribute a segment is not an error, and the
   * numbering restarts whenever the room's stream reopens, so it identifies a
   * voice within one capture run rather than a person across the summit.
   */
  @Column({ type: 'smallint', nullable: true })
  speaker: number | null;

  @Column({
    type: 'enum',
    enum: TranscriptSource,
    default: TranscriptSource.AI,
  })
  source: TranscriptSource;

  /**
   * Milliseconds from the start of the recording.
   *
   * Null for live segments, which arrive one at a time and are ordered by
   * createdAt. The archive pass writes every row at once, so createdAt cannot
   * order them - and an offset is more useful anyway, since it points at a
   * position in the audio rather than at when the row was inserted.
   */
  @Column({ type: 'integer', nullable: true })
  offsetMs: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
