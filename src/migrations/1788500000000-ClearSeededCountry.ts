import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A seeded delegate's country is unset, like its organisation and title. A
 * real self-registered delegate has no country either, and the directory
 * rendered the one field the seeded rows carried that real rows do not as
 * "— · Nigeria" against a real row's plain "—". Rows seeded before that rule
 * are cleared here, scoped to seeded rows only by the same two markers used
 * everywhere else; a real delegate's own country is never touched.
 *
 * A separate migration from ClearSeededOrganisationAndTitle rather than an
 * edit to it: that one is committed, and a committed migration is never
 * edited.
 */
export class ClearSeededCountry1788500000000 implements MigrationInterface {
  name = 'ClearSeededCountry1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "delegates"
      SET "country" = NULL
      WHERE ("hasChosenPassword" = false OR 'seed' = ANY("tags"))
        AND "country" IS NOT NULL
    `);
  }

  public async down(): Promise<void> {
    // no down - the value this clears was never meant to be there
  }
}
