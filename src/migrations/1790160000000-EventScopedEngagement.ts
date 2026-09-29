import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trivia questions, pitch topics and notifications belong to an event
 * (25 Sep 2026), so event organisers can run them for their own events and
 * two events can run them at once without one closing the other's.
 *
 * Existing trivia and pitch topics are given the current edition (or, with
 * none current, the latest to start): they were written for the summit that
 * was running. Existing notifications stay null, which means what it always
 * meant - sent to everyone in the segment.
 */
const TABLES = ['trivia_questions', 'pitch_topics', 'notifications'];

export class EventScopedEngagement1790160000000 implements MigrationInterface {
  name = 'EventScopedEngagement1790160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "editionId" uuid`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "idx_${table}_edition" ON "${table}" ("editionId")`,
      );
    }
    const home = `(SELECT id FROM editions ORDER BY "isCurrent" DESC, "startsAt" DESC LIMIT 1)`;
    for (const table of ['trivia_questions', 'pitch_topics']) {
      await queryRunner.query(
        `UPDATE "${table}" SET "editionId" = ${home} WHERE "editionId" IS NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_${table}_edition"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "editionId"`);
    }
  }
}
