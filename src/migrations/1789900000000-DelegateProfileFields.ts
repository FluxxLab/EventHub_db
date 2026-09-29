import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Profile fields a delegate edits themselves (gender, directory visibility)
 * and the Google account id used by Google sign-in.
 *
 * `directoryVisible` defaults to true so every existing delegate stays listed
 * exactly as before.
 */
export class DelegateProfileFields1789900000000 implements MigrationInterface {
  name = 'DelegateProfileFields1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "gender" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "directoryVisible" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "googleSub" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_delegates_google_sub" ON "delegates" ("googleSub")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_delegates_google_sub"`);
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN IF EXISTS "googleSub"`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN IF EXISTS "directoryVisible"`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN IF EXISTS "gender"`,
    );
  }
}
