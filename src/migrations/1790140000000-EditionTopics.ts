import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tracks and interests per event (25 Sep 2026).
 *
 * Tracks were a Postgres enum shared by sessions and pitch entries, so every
 * event had the GS-27 summit's five. They become rows in `track_options`, a
 * library each edition picks from, and both columns become plain varchar
 * holding the track's value. `general` stays the programme bucket every event
 * has and is not a library row.
 *
 * Each edition gets `trackValues` and `interestValues`, the library values it
 * uses. Existing editions are given everything that exists today, so nothing
 * disappears from the app for an event already running.
 */
const SEED: [string, string, string][] = [
  [
    'digital',
    'Inclusive Digital Transformation',
    'Access, skills and platforms that leave no one out',
  ],
  ['economic', 'Economic Inclusion', 'Finance, enterprise and work'],
  ['gbv', 'Gender-Based Violence (GBV)', 'Prevention, response and justice'],
  ['health', 'Health & Nutrition', 'Maternal health, nutrition and care'],
  [
    'security',
    'Security & Transportation',
    'Safe movement and safe communities',
  ],
];

const ENUMS: { table: string; type: string }[] = [
  { table: 'sessions', type: 'sessions_track_enum' },
  { table: 'pitch_entries', type: 'pitch_entries_track_enum' },
];
const ENUM_VALUES =
  "'digital', 'economic', 'gbv', 'health', 'security', 'general'";

export class EditionTopics1790140000000 implements MigrationInterface {
  name = 'EditionTopics1790140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "track_options" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "value" character varying(40) NOT NULL,
        "label" character varying(80) NOT NULL,
        "hint" character varying(120) NOT NULL DEFAULT '',
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_track_options_value" UNIQUE ("value"),
        CONSTRAINT "PK_track_options" PRIMARY KEY ("id")
      )`);
    for (const [index, [value, label, hint]] of SEED.entries()) {
      await queryRunner.query(
        `INSERT INTO "track_options" ("value", "label", "hint", "sortOrder") VALUES ($1, $2, $3, $4)`,
        [value, label, hint, index],
      );
    }

    for (const { table, type } of ENUMS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "track" TYPE character varying(40) USING "track"::text`,
      );
      await queryRunner.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }

    await queryRunner.query(
      `ALTER TABLE "editions" ADD "trackValues" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "interestValues" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `UPDATE "editions" SET "trackValues" = (SELECT coalesce(array_agg("value" ORDER BY "sortOrder"), '{}') FROM "track_options")`,
    );
    await queryRunner.query(
      `UPDATE "editions" SET "interestValues" = (SELECT coalesce(array_agg("value" ORDER BY "sortOrder", "label"), '{}') FROM "interest_options" WHERE "isActive")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "interestValues"`,
    );
    await queryRunner.query(`ALTER TABLE "editions" DROP COLUMN "trackValues"`);
    for (const { table, type } of ENUMS) {
      // a track added since has no enum value to go back to
      await queryRunner.query(
        `UPDATE "${table}" SET "track" = 'general' WHERE "track" NOT IN (${ENUM_VALUES})`,
      );
      await queryRunner.query(
        `CREATE TYPE "public"."${type}" AS ENUM(${ENUM_VALUES})`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "track" TYPE "public"."${type}" USING "track"::"public"."${type}"`,
      );
    }
    await queryRunner.query(`DROP TABLE "track_options"`);
  }
}
