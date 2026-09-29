import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a sixth track value: `general`.
 *
 * The published agenda files 16 different labels in its track column, but only
 * five of them are thematic tracks. The other eleven — Registration, Opening
 * Ceremony, Networking & Breaks, Plenary, Awards & Closing, Exhibition &
 * Engagement, Education, Research, Leadership & Networking, General Programme,
 * To Be Confirmed — are programme buckets. `track` is NOT NULL, so those rows
 * still need a value, and filing a tea break under "Economic Inclusion" would
 * corrupt the delegate app's track filter. `general` is the honest bucket.
 *
 * Follows the recreate pattern from SummitTracks: Postgres cannot drop an enum
 * value, so `down` has to rebuild the type either way, and recreating in `up`
 * too keeps both directions transaction-safe.
 *
 * Both tables move together — they share the TypeScript `SessionTrack` enum,
 * so leaving pitch_entries behind would let the entity accept a value the
 * column rejects.
 */
const TABLES: { table: string; type: string }[] = [
  { table: 'sessions', type: 'sessions_track_enum' },
  { table: 'pitch_entries', type: 'pitch_entries_track_enum' },
];

const WITH_GENERAL =
  "'digital', 'economic', 'gbv', 'health', 'security', 'general'";
const WITHOUT_GENERAL = "'digital', 'economic', 'gbv', 'health', 'security'";

async function retype(
  queryRunner: QueryRunner,
  table: string,
  type: string,
  values: string,
): Promise<void> {
  await queryRunner.query(
    `CREATE TYPE "public"."${type}_new" AS ENUM(${values})`,
  );
  await queryRunner.query(
    `ALTER TABLE "${table}" ALTER COLUMN "track" TYPE "public"."${type}_new" USING "track"::text::"public"."${type}_new"`,
  );
  await queryRunner.query(`DROP TYPE "public"."${type}"`);
  await queryRunner.query(
    `ALTER TYPE "public"."${type}_new" RENAME TO "${type}"`,
  );
}

export class GeneralTrack1787700000000 implements MigrationInterface {
  name = 'GeneralTrack1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, type } of TABLES) {
      await retype(queryRunner, table, type, WITH_GENERAL);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, type } of TABLES) {
      // Nothing can stay on a value the old type does not have. Economic
      // Inclusion is where the 22 Aug migration already parked the removed
      // plenary and youth tracks, so it is the consistent landing spot.
      await queryRunner.query(
        `UPDATE "${table}" SET "track" = 'economic' WHERE "track" = 'general'`,
      );
      await retype(queryRunner, table, type, WITHOUT_GENERAL);
    }
  }
}
