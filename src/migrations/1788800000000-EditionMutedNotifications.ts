import { MigrationInterface, QueryRunner } from 'typeorm';

/** Which automatic pushes an edition has switched off. */
export class EditionMutedNotifications1788800000000 implements MigrationInterface {
  name = 'EditionMutedNotifications1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "mutedNotifications" text[] NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "mutedNotifications"`,
    );
  }
}
