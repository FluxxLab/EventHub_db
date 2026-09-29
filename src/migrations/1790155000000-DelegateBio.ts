import { MigrationInterface, QueryRunner } from 'typeorm';

/** A short "about me" on the delegate profile (see Delegate.bio). */
export class DelegateBio1790155000000 implements MigrationInterface {
  name = 'DelegateBio1790155000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "bio" character varying(280)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN IF EXISTS "bio"`,
    );
  }
}
