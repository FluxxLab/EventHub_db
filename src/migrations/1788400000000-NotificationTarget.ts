import { MigrationInterface, QueryRunner } from 'typeorm';

/** Where an announcement leads: a session inside the app, or a link outside it. */
export class NotificationTarget1788400000000 implements MigrationInterface {
  name = 'NotificationTarget1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "sessionId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "linkUrl" character varying(500)`,
    );
    // The automatic session notifications sent during the summit were created
    // without their session. Where the title names exactly one session, give
    // it back, so those inbox rows open something rather than nothing.
    await queryRunner.query(`
      UPDATE "notifications" n
      SET "sessionId" = s.id
      FROM "sessions" s
      WHERE n."sessionId" IS NULL
        AND n.category LIKE 'session-%'
        AND n.title = s.title
        AND (SELECT COUNT(*) FROM "sessions" s2 WHERE s2.title = n.title) = 1
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "linkUrl"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP COLUMN "sessionId"`,
    );
  }
}
