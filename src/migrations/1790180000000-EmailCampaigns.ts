import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email campaigns (26 Sep 2026): organisers email an edition's ticket
 * holders from the console. Recipients are snapshotted per campaign when it
 * is sent, so the queue can resume without emailing anyone twice.
 */
export class EmailCampaigns1790180000000 implements MigrationInterface {
  name = 'EmailCampaigns1790180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_campaigns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "subject" varchar(200) NOT NULL,
        "body" text NOT NULL,
        "buttonLabel" varchar(60),
        "buttonUrl" varchar(500),
        "audience" jsonb NOT NULL,
        "status" varchar(10) NOT NULL DEFAULT 'draft',
        "recipients" integer NOT NULL DEFAULT 0,
        "sent" integer NOT NULL DEFAULT 0,
        "failed" integer NOT NULL DEFAULT 0,
        "createdBy" uuid NOT NULL,
        "sentBy" uuid,
        "queuedAt" timestamptz,
        "finishedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_campaigns" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_campaigns_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_email_campaigns_edition" ON "email_campaigns" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "email_campaign_recipients" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "campaignId" uuid NOT NULL,
        "email" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(30) NOT NULL,
        "tier" varchar(100) NOT NULL,
        "status" varchar(10) NOT NULL DEFAULT 'pending',
        "sentAt" timestamptz,
        CONSTRAINT "PK_email_campaign_recipients" PRIMARY KEY ("id"),
        CONSTRAINT "FK_campaign_recipients_campaign" FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_campaign_recipients_pending" ON "email_campaign_recipients" ("campaignId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_campaign_recipient" ON "email_campaign_recipients" ("campaignId", "email")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_campaign_recipients"`);
    await queryRunner.query(`DROP TABLE "email_campaigns"`);
  }
}
