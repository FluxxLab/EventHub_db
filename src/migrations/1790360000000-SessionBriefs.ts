import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Session briefs (20 Oct 2026): the organisers' brief for each session, as
 * text, for the calls-to-action analysis and the rapporteur report to read.
 */
export class SessionBriefs1790360000000 implements MigrationInterface {
  name = 'SessionBriefs1790360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" ADD "brief" text`);
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "briefFileName" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "briefUpdatedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN "briefUpdatedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP COLUMN "briefFileName"`,
    );
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "brief"`);
  }
}
