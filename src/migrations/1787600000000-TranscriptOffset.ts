import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranscriptOffset1787600000000 implements MigrationInterface {
  name = 'TranscriptOffset1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD "offsetMs" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP COLUMN "offsetMs"`,
    );
  }
}
