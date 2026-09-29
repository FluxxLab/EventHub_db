import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications addressed to one delegate, not a segment.
 *
 * Everything the notifications module sent until now went to an audience
 * segment, which is the wrong shape for "Amara added you to their network" -
 * that has exactly one recipient and belongs in exactly one inbox.
 *
 * Nullable, so every existing row stays a broadcast and no backfill is needed.
 */
export class PersonalNotifications1788100000000 implements MigrationInterface {
  name = 'PersonalNotifications1788100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" ADD "delegateId" uuid`);
    // The inbox filters on it for every authenticated read.
    await q.query(
      `CREATE INDEX "IDX_notifications_delegateId" ON "notifications" ("delegateId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "public"."IDX_notifications_delegateId"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN "delegateId"`);
  }
}
