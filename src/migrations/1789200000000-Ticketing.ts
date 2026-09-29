import { MigrationInterface, QueryRunner } from 'typeorm';

/** Ticket tiers, orders, issued tickets and vouchers for the app's checkout. */
export class Ticketing1789200000000 implements MigrationInterface {
  name = 'Ticketing1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ticket_types" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "editionId" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "price" int,
        "perks" text[] NOT NULL DEFAULT '{}',
        "section" varchar(50) NOT NULL DEFAULT 'General',
        "capacity" int,
        "sold" int NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "sortOrder" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ticket_types" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ticket_types_edition" ON "ticket_types" ("editionId")`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "orders_status_enum" AS ENUM ('pending', 'paid', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "delegateId" uuid NOT NULL,
        "editionId" uuid NOT NULL,
        "status" "orders_status_enum" NOT NULL DEFAULT 'pending',
        "lines" jsonb NOT NULL DEFAULT '[]',
        "adminFee" int NOT NULL DEFAULT 0,
        "voucherCode" varchar(50),
        "discount" int NOT NULL DEFAULT 0,
        "total" int NOT NULL DEFAULT 0,
        "guestName" varchar(255) NOT NULL,
        "guestEmail" varchar(255) NOT NULL,
        "guestPhone" varchar(30),
        "paymentMethod" varchar(30),
        "provider" varchar(50),
        "providerRef" varchar(255),
        "paidAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_orders" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_orders_delegate" ON "orders" ("delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_orders_edition" ON "orders" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tickets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "orderId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "editionId" uuid NOT NULL,
        "ticketTypeId" uuid NOT NULL,
        "tierName" varchar(100) NOT NULL,
        "quantity" int NOT NULL DEFAULT 1,
        "code" varchar(30) NOT NULL,
        "guestName" varchar(255) NOT NULL,
        "guestEmail" varchar(255) NOT NULL,
        "section" varchar(50) NOT NULL,
        "row" varchar(20) NOT NULL DEFAULT 'Open',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tickets" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_delegate" ON "tickets" ("delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tickets_edition" ON "tickets" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_tickets_code" ON "tickets" ("code")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vouchers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" varchar(50) NOT NULL,
        "percentOff" int NOT NULL,
        "editionId" uuid,
        "active" boolean NOT NULL DEFAULT true,
        "maxUses" int,
        "uses" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_vouchers" PRIMARY KEY ("id"),
        CONSTRAINT "uq_vouchers_code" UNIQUE ("code")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vouchers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tickets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "orders_status_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ticket_types"`);
  }
}
