import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Session microphones (9 Oct 2026): who speaks into which of the room's mics
 * in each session, so captions and the commitments drawn from them carry
 * names. Empty for every existing session.
 */
export class SessionMics1790280000000 implements MigrationInterface {
  name = 'SessionMics1790280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "mics" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "mics"`);
  }
}
