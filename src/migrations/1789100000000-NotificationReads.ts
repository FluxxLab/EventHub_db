import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-delegate read receipts for inbox notifications; see NotificationRead. */
export class NotificationReads1789100000000 implements MigrationInterface {
  name = 'NotificationReads1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_reads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "delegateId" uuid NOT NULL,
        "notificationId" uuid NOT NULL,
        "readAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_notification_reads" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_notification_reads_pair" ON "notification_reads" ("delegateId", "notificationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_reads"`);
  }
}
