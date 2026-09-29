import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Editions: one row per summit.
 *
 * Also gives every existing session to GS-26, whose dates are read back from
 * those sessions rather than hard-coded, so the seeded row matches whatever is
 * actually in the database.
 */
export class Editions1788600000000 implements MigrationInterface {
  name = 'Editions1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."editions_status_enum" AS ENUM ('draft', 'announced', 'live', 'ended');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "editions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(255) NOT NULL,
        "shortName" character varying(50) NOT NULL,
        "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "venue" character varying(255),
        "status" "public"."editions_status_enum" NOT NULL DEFAULT 'draft',
        "registrationOpen" boolean NOT NULL DEFAULT false,
        "isCurrent" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_editions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_edition_only_one_current"
        ON "editions" ("isCurrent") WHERE "isCurrent" = true
    `);

    // GS-26, dated from its own programme. COALESCE covers a fresh database
    // with no sessions, where the published dates are the best answer.
    await queryRunner.query(`
      INSERT INTO "editions"
        ("name", "shortName", "startsAt", "endsAt", "venue", "status", "registrationOpen", "isCurrent")
      SELECT
        'GS-26 Gender and Inclusion Summit',
        'GS-26',
        COALESCE(MIN(s."startsAt"), TIMESTAMPTZ '2026-09-08 08:00:00+01'),
        COALESCE(MAX(s."endsAt"),   TIMESTAMPTZ '2026-09-09 17:00:00+01'),
        'Abuja, Nigeria',
        'ended',
        false,
        true
      FROM "sessions" s
      WHERE NOT EXISTS (SELECT 1 FROM "editions")
    `);

    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "editionId" uuid`,
    );
    await queryRunner.query(`
      UPDATE "sessions"
      SET "editionId" = (SELECT id FROM "editions" WHERE "shortName" = 'GS-26' LIMIT 1)
      WHERE "editionId" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_session_edition" ON "sessions" ("editionId")
    `);
    // No foreign key on purpose while the column is still nullable: an edition
    // deleted by mistake should not take the programme with it. The constraint
    // belongs with the change that makes the column NOT NULL.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_session_edition"`);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN IF EXISTS "editionId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "editions"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."editions_status_enum"`,
    );
  }
}
