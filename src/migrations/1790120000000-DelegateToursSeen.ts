import { MigrationInterface, QueryRunner } from 'typeorm';

/** The in-app tours each delegate has finished or skipped (see Delegate.toursSeen). */
export class DelegateToursSeen1790120000000 implements MigrationInterface {
  name = 'DelegateToursSeen1790120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "toursSeen" text[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN IF EXISTS "toursSeen"`,
    );
  }
}
