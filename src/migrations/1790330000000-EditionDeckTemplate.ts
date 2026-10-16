import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deck template (16 Oct 2026): each event chooses how its call-to-action
 * decks look, designed from its brand (as before, the default for every
 * existing event) or the Build conference's commitment template.
 */
export class EditionDeckTemplate1790330000000 implements MigrationInterface {
  name = 'EditionDeckTemplate1790330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "deckTemplate" character varying(20) NOT NULL DEFAULT 'designed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "deckTemplate"`,
    );
  }
}
