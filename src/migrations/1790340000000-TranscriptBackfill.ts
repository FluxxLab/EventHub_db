import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Desk back-fill (17 Oct 2026): caption lines written from a capture desk's
 * own recording, uploaded after a dropped link, are marked so the archive
 * pass keeps them. False for every existing row.
 */
export class TranscriptBackfill1790340000000 implements MigrationInterface {
  name = 'TranscriptBackfill1790340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "backfill" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "backfill"`,
    );
  }
}
