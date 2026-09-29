import { MigrationInterface, QueryRunner } from 'typeorm';

/** Exhibition stands and the stamps delegates collect at them. */
export class ExhibitionPassport1789510000000 implements MigrationInterface {
  name = 'ExhibitionPassport1789510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "booths" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "editionId" uuid NOT NULL,
        "name" varchar(120) NOT NULL,
        "code" varchar(12) NOT NULL,
        "description" text,
        "location" varchar(120),
        "sortOrder" int NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_booths" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_booths_edition" ON "booths" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_booths_code" ON "booths" ("code")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "booth_stamps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "boothId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_booth_stamps" PRIMARY KEY ("id")
      )
    `);
    // the unique pair is what makes a repeat scan a no-op
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_booth_stamps_pair" ON "booth_stamps" ("boothId", "delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_booth_stamps_booth" ON "booth_stamps" ("boothId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_booth_stamps_delegate" ON "booth_stamps" ("delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "booth_stamps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "booths"`);
  }
}
