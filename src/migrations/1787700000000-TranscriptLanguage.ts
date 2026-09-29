import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists caption translations alongside the English transcript.
 *
 * Existing rows are all Deepgram English, so the column defaults to 'en' and
 * backfills correctly without a data migration.
 */
export class TranscriptLanguage1787700000000 implements MigrationInterface {
  name = 'TranscriptLanguage1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "language" character varying(8) NOT NULL DEFAULT 'en'`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "sourceSegmentId" uuid`,
    );
    /**
     * SET NULL rather than CASCADE: deleting an English segment should not
     * silently delete every translation of it. An orphaned translation is
     * still readable; a vanished one is not.
     */
    await queryRunner.query(`
      ALTER TABLE "transcript_segments"
        ADD CONSTRAINT "FK_transcript_source_segment"
        FOREIGN KEY ("sourceSegmentId") REFERENCES "transcript_segments"("id")
        ON DELETE SET NULL
    `);
    /**
     * The backfill query is always "this session, this language, in order",
     * so the index matches it exactly.
     */
    await queryRunner.query(`
      CREATE INDEX "idx_transcript_session_language"
        ON "transcript_segments" ("sessionId", "language", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_transcript_session_language"`);
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP CONSTRAINT "FK_transcript_source_segment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "sourceSegmentId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "language"`,
    );
  }
}
