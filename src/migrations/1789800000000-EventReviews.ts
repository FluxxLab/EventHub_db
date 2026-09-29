import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One review per delegate per edition, shown on the app's event page. Hidden
 * is the console's moderation switch: the row stays, it just stops counting.
 */
export class EventReviews1789800000000 implements MigrationInterface {
  name = 'EventReviews1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "event_reviews" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "editionId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "rating" smallint NOT NULL,
        "comment" varchar(1000),
        "hidden" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_event_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "chk_event_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_event_reviews_edition" ON "event_reviews" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_event_reviews_unique" ON "event_reviews" ("editionId", "delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "event_reviews"`);
  }
}
