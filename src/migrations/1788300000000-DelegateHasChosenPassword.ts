import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * True for a delegate who set their own password; false for an account the
 * system created on their behalf, with a password nobody holds.
 *
 * That distinction is what password reset now checks, replacing a check
 * against the free-form `tags` column for a literal 'seed' entry. Tags exist
 * to classify real delegates (speaker, volunteer); folding "never email this
 * one a reset code" into the same column meant every future reader of tags
 * had to separately know 'seed' was special. This gives the one thing that
 * actually matters its own column.
 *
 * Defaults true, so every account that exists today - all of them real and
 * self-registered - is unaffected. The seed importer sets it false per row
 * it creates.
 */
export class DelegateHasChosenPassword1788300000000 implements MigrationInterface {
  name = 'DelegateHasChosenPassword1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN "hasChosenPassword" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN "hasChosenPassword"`,
    );
  }
}
