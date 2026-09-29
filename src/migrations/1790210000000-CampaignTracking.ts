import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campaign opens and clicks (26 Sep 2026): counted per recipient, totalled
 * per campaign (each person once), and per link for the campaign's report.
 * `tracked` says whether a campaign went out with tracking on.
 */
export class CampaignTracking1790210000000 implements MigrationInterface {
  name = 'CampaignTracking1790210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "email_campaign_recipients"
        ADD COLUMN "opens" integer NOT NULL DEFAULT 0,
        ADD COLUMN "clicks" integer NOT NULL DEFAULT 0,
        ADD COLUMN "openedAt" timestamptz,
        ADD COLUMN "clickedAt" timestamptz`);
    await queryRunner.query(`
      ALTER TABLE "email_campaigns"
        ADD COLUMN "opened" integer NOT NULL DEFAULT 0,
        ADD COLUMN "clicked" integer NOT NULL DEFAULT 0,
        ADD COLUMN "tracked" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`
      CREATE TABLE "email_campaign_links" (
        "campaignId" uuid NOT NULL,
        "url" varchar(500) NOT NULL,
        "clicks" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_email_campaign_links" PRIMARY KEY ("campaignId", "url"),
        CONSTRAINT "FK_email_campaign_links_campaign" FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE CASCADE
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_campaign_links"`);
    await queryRunner.query(
      `ALTER TABLE "email_campaigns" DROP COLUMN "tracked", DROP COLUMN "clicked", DROP COLUMN "opened"`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_campaign_recipients" DROP COLUMN "clickedAt", DROP COLUMN "openedAt", DROP COLUMN "clicks", DROP COLUMN "opens"`,
    );
  }
}
