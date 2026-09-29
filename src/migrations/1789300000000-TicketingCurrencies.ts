import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prices per currency on ticket tiers and the currency an order was placed
 * in. Existing naira prices become the NGN entry of the map.
 */
export class TicketingCurrencies1789300000000 implements MigrationInterface {
  name = 'TicketingCurrencies1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ticket_types" ADD COLUMN IF NOT EXISTS "prices" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(`
      UPDATE "ticket_types"
      SET "prices" = jsonb_build_object('NGN', "price")
      WHERE "price" IS NOT NULL AND "prices" = '{}'::jsonb
    `);
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "currency" varchar(3) NOT NULL DEFAULT 'NGN'`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "country" varchar(2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "country"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "currency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_types" DROP COLUMN IF EXISTS "prices"`,
    );
  }
}
