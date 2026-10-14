import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caption vocabulary (14 Oct 2026): the words each event's captions listen
 * for, alongside its speakers' names. Empty for every existing event.
 */
export class CaptionTerms1790310000000 implements MigrationInterface {
  name = 'CaptionTerms1790310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "captionTerms" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "captionTerms"`,
    );
  }
}
