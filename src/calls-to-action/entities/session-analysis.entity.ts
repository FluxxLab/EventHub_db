import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * How far a session's transcript has been analysed for calls to action. Each
 * Analyse reads only the lines after `analysedUpTo`, so pressing it at every
 * break, and once more at the end, never suggests the same thing twice.
 */
@Entity('session_analyses')
export class SessionAnalysis {
  @PrimaryColumn({ type: 'uuid' })
  sessionId: string;

  /** When the last line read was said. */
  @Column({ type: 'timestamptz' })
  analysedUpTo: Date;

  /** Analyses run for the session, for the console's "analysed twice" hint. */
  @Column({ type: 'int', default: 0 })
  runs: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
