import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trivia scoring and discussion locks (26 Sep 2026).
 *
 * - `trivia_questions.liveAt`: when a question went live, the start of the
 *   speed bonus. Null for questions pushed before now; their correct answers
 *   score the base 100 with no bonus (trivia-scoring.ts).
 * - `trivia_answers.points`: what an answer scored, set when its question
 *   closes. Backfill: answers to questions already closed are scored now,
 *   100 for correct and 0 otherwise (no bonus - their start time was never
 *   recorded), so an event's board includes the rounds already played.
 *   Answers to a question still live or in draft stay null until it closes.
 * - `discussion_locks`: a row per session whose thread is closed to new
 *   comments. Goes with its session.
 *
 * Edition scoping for trivia and pitch topics (column, index, backfill to the
 * current or latest event) is EventScopedEngagement1790160000000; this one
 * does not depend on it. Every statement is idempotent, so running it after
 * that one on a database that already has it is safe.
 */
export class LiveEngagement1790145000000 implements MigrationInterface {
  name = 'LiveEngagement1790145000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "trivia_questions" ADD COLUMN IF NOT EXISTS "liveAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "trivia_answers" ADD COLUMN IF NOT EXISTS "points" integer`,
    );
    await queryRunner.query(`
      UPDATE "trivia_answers" a
         SET "points" = CASE WHEN a."chosenOption"::text = q."correctOption"::text THEN 100 ELSE 0 END
        FROM "trivia_questions" q
       WHERE q."id" = a."questionId"
         AND q."status" = 'closed'
         AND a."points" IS NULL`);
    // The board rebuild reads answers by question; ScaleIndexes made this
    // index, repeated here so the entity and a fresh database agree.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_trivia_answers_question" ON "trivia_answers" ("questionId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discussion_locks" (
        "sessionId" uuid NOT NULL,
        "lockedBy" uuid,
        "lockedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_discussion_locks" PRIMARY KEY ("sessionId"),
        CONSTRAINT "FK_discussion_locks_session" FOREIGN KEY ("sessionId")
          REFERENCES "sessions"("id") ON DELETE CASCADE
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "discussion_locks"`);
    await queryRunner.query(
      `ALTER TABLE "trivia_answers" DROP COLUMN IF EXISTS "points"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trivia_questions" DROP COLUMN IF EXISTS "liveAt"`,
    );
  }
}
