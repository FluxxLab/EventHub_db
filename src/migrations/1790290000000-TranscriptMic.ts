import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transcript mics (14 Oct 2026): the microphone each caption line was said
 * into, when a room's mics reach the captions one per channel. Null for every
 * earlier line.
 */
export class TranscriptMic1790290000000 implements MigrationInterface {
  name = 'TranscriptMic1790290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "mic" smallint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "mic"`,
    );
  }
}
