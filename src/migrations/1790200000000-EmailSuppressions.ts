import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unsubscribing (26 Sep 2026): addresses that opted out of campaign
 * emails. Campaigns leave them out; sign-in codes and tickets still go.
 */
export class EmailSuppressions1790200000000 implements MigrationInterface {
  name = 'EmailSuppressions1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_suppressions" (
        "email" varchar(255) NOT NULL,
        "source" varchar(20) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_suppressions" PRIMARY KEY ("email")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_suppressions"`);
  }
}
