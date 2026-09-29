import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product analytics events reported by the app. Append-only; the summary
 * endpoint aggregates by name, day and platform, hence those three indexes.
 */
export class AnalyticsEvents1789600000000 implements MigrationInterface {
  name = 'AnalyticsEvents1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "analytics_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "delegateId" uuid,
        "name" varchar(60) NOT NULL,
        "props" jsonb NOT NULL DEFAULT '{}',
        "platform" varchar(10) NOT NULL,
        "appVersion" varchar(20),
        "occurredAt" timestamptz NOT NULL,
        "receivedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_analytics_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_delegate" ON "analytics_events" ("delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_name" ON "analytics_events" ("name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_occurred" ON "analytics_events" ("occurredAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "analytics_events"`);
  }
}
