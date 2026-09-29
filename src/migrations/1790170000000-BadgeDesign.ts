import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Name badges (26 Sep 2026): each edition keeps its badge design beside its
 * certificate design. Null until the organisers save one; the console then
 * prints with its defaults.
 */
export class BadgeDesign1790170000000 implements MigrationInterface {
  name = 'BadgeDesign1790170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "badgeDesign" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "editions" DROP COLUMN "badgeDesign"`);
  }
}
