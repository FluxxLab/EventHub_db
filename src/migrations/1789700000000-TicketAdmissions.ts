import { MigrationInterface, QueryRunner } from 'typeorm';

/** People let through the entrance gate on a ticket, one row per person. */
export class TicketAdmissions1789700000000 implements MigrationInterface {
  name = 'TicketAdmissions1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ticket_admissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ticketId" uuid NOT NULL,
        "editionId" uuid NOT NULL,
        "scannedBy" uuid NOT NULL,
        "admittedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ticket_admissions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ticket_admissions_ticket" ON "ticket_admissions" ("ticketId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ticket_admissions_edition" ON "ticket_admissions" ("editionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_admissions"`);
  }
}
