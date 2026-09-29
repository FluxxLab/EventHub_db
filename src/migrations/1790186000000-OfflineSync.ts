import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Offline sends from the app (the venue wifi drops for minutes at a time).
 *
 * session_comments.clientId: the id the app gave a comment when it was
 * written. A comment queued offline, or retried after a timeout, carries the
 * same id every time, so the second arrival returns the first row instead of
 * posting twice. Unique per author; null for comments from older builds.
 *
 * ticket_admissions: a gate phone that lost signal keeps scanning against a
 * downloaded manifest and uploads its admissions later. `clientId` makes the
 * upload safe to retry, `deviceId` says which phone, `syncedAt` marks a row
 * that arrived late (its `admittedAt` is the original scan time).
 */
export class OfflineSync1790186000000 implements MigrationInterface {
  name = 'OfflineSync1790186000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_comments" ADD COLUMN IF NOT EXISTS "clientId" uuid`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_session_comments_author_client" ON "session_comments" ("authorId", "clientId") WHERE "clientId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" ADD COLUMN IF NOT EXISTS "clientId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" ADD COLUMN IF NOT EXISTS "deviceId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" ADD COLUMN IF NOT EXISTS "syncedAt" timestamptz`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_ticket_admissions_client" ON "ticket_admissions" ("clientId") WHERE "clientId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_ticket_admissions_client"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" DROP COLUMN IF EXISTS "syncedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" DROP COLUMN IF EXISTS "deviceId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_admissions" DROP COLUMN IF EXISTS "clientId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_session_comments_author_client"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_comments" DROP COLUMN IF EXISTS "clientId"`,
    );
  }
}
