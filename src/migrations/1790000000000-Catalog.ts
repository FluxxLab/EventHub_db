import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API-managed reference data (24 Sep 2026): the interest picker and the My
 * Events category tiles move out of the app. Seeded with exactly what the
 * app shipped, so switching the app over changes nothing a delegate sees.
 */
export class Catalog1790000000000 implements MigrationInterface {
  name = 'Catalog1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "interest_options" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "value" varchar(60) NOT NULL,
        "label" varchar(60) NOT NULL,
        "sortOrder" int NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_interest_options" PRIMARY KEY ("id"),
        CONSTRAINT "uq_interest_options_value" UNIQUE ("value")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "interest_options" ("value", "label", "sortOrder") VALUES
        ('Policy', 'Policy', 0),
        ('Governance', 'Governance', 1),
        ('Health', 'Health', 2),
        ('Education', 'Education', 3),
        ('Fintech', 'Fintech', 4),
        ('Agriculture', 'Agriculture', 5),
        ('Technology', 'Technology', 6),
        ('Research', 'Research', 7),
        ('Trade', 'Trade', 8),
        ('Climate', 'Climate', 9),
        ('Media', 'Media', 10),
        ('Youth', 'Youth', 11)
      ON CONFLICT ("value") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "category_settings" (
        "slug" varchar(40) NOT NULL,
        "label" varchar(60) NOT NULL,
        "imageKey" varchar(500),
        "sortOrder" int NOT NULL DEFAULT 0,
        CONSTRAINT "pk_category_settings" PRIMARY KEY ("slug")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "category_settings" ("slug", "label", "sortOrder") VALUES
        ('summits', 'Summits', 0),
        ('workshops', 'Workshops', 1),
        ('roundtables', 'Roundtables', 2),
        ('conferences', 'Conferences', 3),
        ('fellowships', 'Fellowships', 4),
        ('training', 'Classes & Training', 5),
        ('exhibitions', 'Exhibitions', 6),
        ('community', 'Community Events', 7)
      ON CONFLICT ("slug") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "category_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "interest_options"`);
  }
}
