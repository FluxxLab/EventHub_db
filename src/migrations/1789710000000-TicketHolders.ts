import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tickets bought for other people. The order keeps who each place is for;
 * each issued ticket belongs to its holder and remembers the buyer, who can
 * see it without its entry QR.
 */
export class TicketHolders1789710000000 implements MigrationInterface {
  name = 'TicketHolders1789710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "attendees" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "purchasedBy" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_purchased_by" ON "tickets" ("purchasedBy")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tickets_purchased_by"`);
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP COLUMN IF EXISTS "purchasedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "attendees"`,
    );
  }
}
