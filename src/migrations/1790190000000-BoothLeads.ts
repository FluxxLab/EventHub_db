import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exhibition lead capture (26 Sep 2026): stand staff scan delegates' badges
 * from a private link, no account needed. Only a hash of each link's secret
 * is stored; leads are one per delegate per stand.
 */
export class BoothLeads1790190000000 implements MigrationInterface {
  name = 'BoothLeads1790190000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "booth_lead_keys" (
        "boothId" uuid NOT NULL,
        "keyHash" varchar(64) NOT NULL,
        "createdBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_booth_lead_keys" PRIMARY KEY ("boothId"),
        CONSTRAINT "FK_booth_lead_keys_booth" FOREIGN KEY ("boothId") REFERENCES "booths"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`
      CREATE TABLE "booth_leads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "boothId" uuid NOT NULL,
        "editionId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "ticketId" uuid NOT NULL,
        "note" varchar(1000),
        "rating" varchar(10),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_booth_leads" PRIMARY KEY ("id"),
        CONSTRAINT "FK_booth_leads_booth" FOREIGN KEY ("boothId") REFERENCES "booths"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_booth_leads_delegate" FOREIGN KEY ("delegateId") REFERENCES "delegates"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_booth_lead" ON "booth_leads" ("boothId", "delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_booth_leads_edition" ON "booth_leads" ("editionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "booth_leads"`);
    await queryRunner.query(`DROP TABLE "booth_lead_keys"`);
  }
}
