import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which app features an edition switches on, and the practical information
 * (wifi, help desk, breaks) the app's Help screen shows.
 *
 * The default feature list is what the post-summit report kept: everything
 * GS-26 delegates actually used. Discussions, voting and trivia are off
 * unless a host drives them, so an edition set up from the console without
 * a thought about features gets the set that worked.
 */
export class EditionFeaturesInfo1789630000000 implements MigrationInterface {
  name = 'EditionFeaturesInfo1789630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "features" text[] NOT NULL DEFAULT '{schedule,speakers,venue,notifications,resources,captions,audio,questions,materials,feedback,polls,passport}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "info" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "info"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "features"`,
    );
  }
}
