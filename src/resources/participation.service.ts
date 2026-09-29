import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * The participation checklist that unlocks a certificate.
 *
 * Read-only and cross-module by nature - it spans attendance, trivia, voting,
 * connections and discussions - so it queries counts directly through the
 * DataSource rather than wiring five modules' entities into this one. Nothing
 * here writes, so there is no ownership to muddle.
 *
 * Each step is defined by what a delegate actually did, not by a flag someone
 * sets: the certificate says "participation", and this is what makes that claim
 * true rather than decorative.
 */
export interface ParticipationStep {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  /** present when a step needs more than one of something */
  current?: number;
  required?: number;
}

export interface ParticipationStatus {
  steps: ParticipationStep[];
  completed: number;
  total: number;
  unlocked: boolean;
}

/** Delegates must connect with this many others before the certificate unlocks. */
const CONNECTIONS_REQUIRED = 4;

@Injectable()
export class ParticipationService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async statusFor(delegateId: string): Promise<ParticipationStatus> {
    const [registered, attended, trivia, pitch, connections, comments] =
      await Promise.all([
        this.count(
          `SELECT COUNT(*) FROM delegates WHERE id = $1 AND "consentAt" IS NOT NULL`,
          [delegateId],
        ),
        this.count(
          `SELECT COUNT(*) FROM session_attendance WHERE "delegateId" = $1`,
          [delegateId],
        ),
        this.count(
          `SELECT COUNT(*) FROM trivia_answers WHERE "delegateId" = $1`,
          [delegateId],
        ),
        this.count(`SELECT COUNT(*) FROM pitch_votes WHERE "delegateId" = $1`, [
          delegateId,
        ]),
        /**
         * Connections are directed edges, so a delegate's network spans both
         * columns - counting only fromDelegateId would ignore everyone who
         * scanned *their* pass. DISTINCT on the other party so a pair that
         * connected both ways still counts once.
         */
        this.count(
          `SELECT COUNT(DISTINCT other) FROM (
           SELECT "toDelegateId" AS other FROM delegate_connections WHERE "fromDelegateId" = $1
           UNION
           SELECT "fromDelegateId" AS other FROM delegate_connections WHERE "toDelegateId" = $1
         ) AS network`,
          [delegateId],
        ),
        this.count(
          `SELECT COUNT(*) FROM session_comments WHERE "authorId" = $1`,
          [delegateId],
        ),
      ]);

    const steps: ParticipationStep[] = [
      {
        key: 'registration',
        label: 'Complete your registration',
        hint: 'Your delegate profile and consent',
        done: registered > 0,
      },
      {
        key: 'session',
        label: 'Join a live session',
        hint: 'Open a session while it is running',
        done: attended > 0,
      },
      {
        key: 'trivia',
        label: 'Attempt the summit trivia',
        hint: 'Answer any question',
        done: trivia > 0,
      },
      {
        key: 'pitchathon',
        label: 'Vote in the Pitchathon',
        hint: 'Back an innovator',
        done: pitch > 0,
      },
      {
        key: 'connections',
        label: `Connect with ${CONNECTIONS_REQUIRED} delegates`,
        hint: 'Scan passes or connect from the directory',
        done: connections >= CONNECTIONS_REQUIRED,
        current: Math.min(connections, CONNECTIONS_REQUIRED),
        required: CONNECTIONS_REQUIRED,
      },
      {
        key: 'discussion',
        label: 'Join a session discussion',
        hint: 'Post a comment on any session',
        done: comments > 0,
      },
    ];

    const completed = steps.filter((s) => s.done).length;
    return {
      steps,
      completed,
      total: steps.length,
      unlocked: completed === steps.length,
    };
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    const rows = await this.db.query(sql, params);
    return Number(rows[0]?.count ?? 0);
  }
}
