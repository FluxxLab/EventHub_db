import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the app's Home needs to draw an edition as a card: a category for the
 * My Events grid, a city for the pin line, a cover image and a description
 * for the details page. Every existing row stays a summit with no cover; the
 * app falls back to its bundled artwork until the console sets one.
 */
export class EditionHomeFields1789000000000 implements MigrationInterface {
  name = 'EditionHomeFields1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "editions_category_enum" AS ENUM (
          'summits', 'workshops', 'roundtables', 'conferences',
          'fellowships', 'training', 'exhibitions', 'community'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "category" "editions_category_enum" NOT NULL DEFAULT 'summits'`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "city" varchar(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "coverImage" varchar(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "description" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "description"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "coverImage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "city"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "editions_category_enum"`);
  }
}
