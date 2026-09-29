import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-edition venue details the app used to hard-code: a street address,
 * the terms under each ticket, and a described list of rooms.
 *
 * Existing editions get the five ticket terms the app has been showing, so
 * nothing changes for a ticket already issued. The column default stays
 * empty; new editions get the same five from the service.
 */
export class EditionAddressTermsRooms1790010000000 implements MigrationInterface {
  name = 'EditionAddressTermsRooms1790010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "address" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "ticketTerms" text[] NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(`
      UPDATE "editions" SET "ticketTerms" = ARRAY[
        'Tickets are non-refundable unless the event is cancelled.',
        'Each ticket is valid for one person only.',
        'Please show your e-ticket (QR code) at the entrance.',
        'Event details may change without prior notice.',
        'Photos and videos may be used for promotion.'
      ]::text[]
      WHERE "ticketTerms" = '{}'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "edition_rooms" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "editionId" uuid NOT NULL,
        "name" varchar(120) NOT NULL,
        "floor" varchar(60),
        "notes" varchar(500),
        "sortOrder" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_edition_rooms" PRIMARY KEY ("id"),
        CONSTRAINT "fk_edition_rooms_edition" FOREIGN KEY ("editionId")
          REFERENCES "editions" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_edition_rooms_edition" ON "edition_rooms" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_edition_rooms_name" ON "edition_rooms" ("editionId", lower("name"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "edition_rooms"`);
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "ticketTerms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "address"`,
    );
  }
}
