import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stakeholder links (20 Oct 2026): broad call-to-action targets ("Federal
 * Government") tied to the event's organisations that fall under them,
 * suggested by the AI and confirmed by organisers.
 */
export class StakeholderLinks1790370000000 implements MigrationInterface {
  name = 'StakeholderLinks1790370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "stakeholder_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "target" character varying(200) NOT NULL,
        "targetKey" character varying(200) NOT NULL,
        "organisation" character varying(255) NOT NULL,
        "organisationKey" character varying(255) NOT NULL,
        "status" character varying(16) NOT NULL,
        "reason" character varying(300),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stakeholder_links" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stakeholder_link_edition" ON "stakeholder_links" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_stakeholder_link" ON "stakeholder_links" ("editionId", "targetKey", "organisationKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_stakeholder_link"`);
    await queryRunner.query(`DROP INDEX "idx_stakeholder_link_edition"`);
    await queryRunner.query(`DROP TABLE "stakeholder_links"`);
  }
}
