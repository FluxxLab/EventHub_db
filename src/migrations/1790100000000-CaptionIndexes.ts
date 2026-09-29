import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the caption hot paths.
 *
 * 1. Catch-up and gap-fill read "this session, this language, newest first"
 *    ordered by `offsetMs DESC, createdAt DESC` (archived rows by offset, live
 *    rows - offset null, which Postgres sorts first under DESC - by time). The
 *    existing (sessionId, language, createdAt) index cannot serve that order,
 *    so every late joiner sorted the whole session. This one matches it
 *    exactly, including NULLS FIRST, and scanned backwards also serves the
 *    full transcript's ASC order.
 *
 * 2. sourceSegmentId has a self-referencing FK with ON DELETE SET NULL.
 *    Without an index, deleting an English row (clearing a session, the
 *    archive pass replacing live rows) scans the whole table once per deleted
 *    row to find its translations.
 */
export class CaptionIndexes1790100000000 implements MigrationInterface {
  name = 'CaptionIndexes1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transcript_session_language_order"
        ON "transcript_segments"
        ("sessionId", "language", "offsetMs" DESC NULLS FIRST, "createdAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transcript_source_segment"
        ON "transcript_segments" ("sourceSegmentId")
        WHERE "sourceSegmentId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transcript_source_segment"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_transcript_session_language_order"`,
    );
  }
}
