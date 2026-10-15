import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brand kit (15 Oct 2026): each event's logo for dark backgrounds and its
 * brand guide (a PDF, with its file name), which the call-to-action decks are
 * designed from. Empty for every existing event.
 */
export class EditionBrandKit1790320000000 implements MigrationInterface {
  name = 'EditionBrandKit1790320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "logoDarkImage" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "brandGuide" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "brandGuideName" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "brandGuideName"`,
    );
    await queryRunner.query(`ALTER TABLE "editions" DROP COLUMN "brandGuide"`);
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "logoDarkImage"`,
    );
  }
}
