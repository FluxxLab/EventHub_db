import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A session can have several recordings. The existing single link becomes
 * the first entry so nothing already published disappears.
 */
export class SessionVideos1788900000000 implements MigrationInterface {
  name = 'SessionVideos1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "videos" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(`
      UPDATE "sessions"
      SET "videos" = jsonb_build_array(jsonb_build_object('url', "videoUrl"))
      WHERE "videoUrl" IS NOT NULL AND "videos" = '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN IF EXISTS "videos"`,
    );
  }
}
