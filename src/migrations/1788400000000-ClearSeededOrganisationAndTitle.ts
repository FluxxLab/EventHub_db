import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A seeded delegate's organisation and title are never invented (see
 * delegate-seed.data.ts) - they should read as unset, not as an empty
 * value. Rows seeded before that rule existed carry a real organisation
 * name from the old synthetic pool, or an empty string '' from the version
 * in between that meant "blank" but still wrote a value to the column. Both
 * are cleared to NULL here so the column is actually empty rather than
 * merely empty-looking.
 *
 * Scoped to seeded rows only, via the same two markers used everywhere else
 * a row's seeded-ness matters: `hasChosenPassword` false, or - for a row
 * older than that column - the legacy `seed` tag. A real delegate's own
 * organisation or title is never touched.
 */
export class ClearSeededOrganisationAndTitle1788400000000 implements MigrationInterface {
  name = 'ClearSeededOrganisationAndTitle1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "delegates"
      SET "organisation" = NULL, "title" = NULL
      WHERE ("hasChosenPassword" = false OR 'seed' = ANY("tags"))
        AND ("organisation" IS NOT NULL OR "title" IS NOT NULL)
    `);
  }

  public async down(): Promise<void> {
    // no down - the values this clears were never meant to be there, and
    // what they used to say is not recoverable from the database anyway
  }
}
