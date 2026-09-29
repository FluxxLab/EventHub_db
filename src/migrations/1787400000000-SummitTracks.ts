import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The five confirmed thematic tracks (22 Aug 2026).
 *
 * Postgres cannot drop a value from an enum in place, so each type is
 * recreated. Rows on a removed track are moved first, otherwise the cast to
 * the new type fails:
 *   innovation -> digital  (Inclusive Digital Transformation)
 *   plenary    -> economic (Economic Inclusion)
 *   youth      -> economic (Economic Inclusion)
 *
 * Two tables carry the same set of values under different type names, and both
 * have to move together or the Pitchathon breaks.
 */
const TABLES: { table: string; type: string }[] = [
  { table: 'sessions', type: 'sessions_track_enum' },
  { table: 'pitch_entries', type: 'pitch_entries_track_enum' },
];

const NEW_VALUES = "'digital', 'economic', 'gbv', 'health', 'security'";
const OLD_VALUES =
  "'plenary', 'gbv', 'health', 'economic', 'innovation', 'digital', 'youth'";

export class SummitTracks1787400000000 implements MigrationInterface {
  name = 'SummitTracks1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, type } of TABLES) {
      // Move rows off the tracks that are going away.
      await queryRunner.query(
        `UPDATE "${table}" SET "track" = 'digital' WHERE "track" = 'innovation'`,
      );
      await queryRunner.query(
        `UPDATE "${table}" SET "track" = 'economic' WHERE "track" IN ('plenary', 'youth')`,
      );

      await queryRunner.query(
        `CREATE TYPE "public"."${type}_new" AS ENUM(${NEW_VALUES})`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "track" TYPE "public"."${type}_new" USING "track"::text::"public"."${type}_new"`,
      );
      await queryRunner.query(`DROP TYPE "public"."${type}"`);
      await queryRunner.query(
        `ALTER TYPE "public"."${type}_new" RENAME TO "${type}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the old type. The reassignments above are not reversible: rows
    // moved off plenary, innovation and youth stay where they were put.
    for (const { table, type } of TABLES) {
      await queryRunner.query(
        `CREATE TYPE "public"."${type}_old" AS ENUM(${OLD_VALUES})`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "track" TYPE "public"."${type}_old" USING "track"::text::"public"."${type}_old"`,
      );
      await queryRunner.query(`DROP TYPE "public"."${type}"`);
      await queryRunner.query(
        `ALTER TYPE "public"."${type}_old" RENAME TO "${type}"`,
      );
    }
  }
}
