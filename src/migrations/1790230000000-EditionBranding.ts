import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-event branding (27 Sep 2026): a logo and a button colour for the app's
 * event screens. Both optional; an event without them looks as before.
 */
export class EditionBranding1790230000000 implements MigrationInterface {
  name = 'EditionBranding1790230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "logoImage" varchar(512), ADD "brandColor" varchar(7)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "brandColor", DROP COLUMN "logoImage"`,
    );
  }
}
