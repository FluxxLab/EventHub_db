import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Passing a gift ticket on to someone else.
 *
 * tickets.qrVersion is bumped when the buyer passes a ticket on; the entry
 * QR's signature covers it, so the previous holder's QR stops admitting.
 * Every existing ticket is version 0, which signs exactly as before, so QRs
 * already on phones and printed badges keep working.
 */
export class TicketTransfers1790135000000 implements MigrationInterface {
  name = 'TicketTransfers1790135000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "qrVersion" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP COLUMN IF EXISTS "qrVersion"`,
    );
  }
}
