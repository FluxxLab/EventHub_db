import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice notes in DMs (26 Sep 2026): a message may carry one audio clip,
 * stored as a key under the sender's own upload folder. The key is unique so
 * one upload can back only one message. Idempotent both ways.
 */
export class DirectMessageAudio1790195000000 implements MigrationInterface {
  name = 'DirectMessageAudio1790195000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "direct_messages"
        ADD COLUMN IF NOT EXISTS "audioKey" varchar(255),
        ADD COLUMN IF NOT EXISTS "audioDurationMs" integer,
        ADD COLUMN IF NOT EXISTS "audioContentType" varchar(50)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_dm_audio_key" ON "direct_messages" ("audioKey") WHERE "audioKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_dm_audio_key"`);
    await queryRunner.query(`
      ALTER TABLE "direct_messages"
        DROP COLUMN IF EXISTS "audioContentType",
        DROP COLUMN IF EXISTS "audioDurationMs",
        DROP COLUMN IF EXISTS "audioKey"`);
  }
}
