import { MigrationInterface, QueryRunner } from 'typeorm';

/** A link to each session's recording or live stream. Nullable: most sessions
 *  never get one, and the column is read by every client that lists sessions. */
export class SessionVideoUrl1788300000000 implements MigrationInterface {
  name = 'SessionVideoUrl1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "videoUrl" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "videoUrl"`);
  }
}
