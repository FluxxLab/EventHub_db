import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranscriptSpeaker1787300000000 implements MigrationInterface {
  name = 'TranscriptSpeaker1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "speaker" smallint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "speaker"`,
    );
  }
}
