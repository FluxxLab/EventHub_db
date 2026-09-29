import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Event organisers (25 Sep 2026): a staff tier that runs only the editions
 * assigned to it. The enum value is added outside a transaction, as with
 * session_admin; the assignment is an array on the account, since it is read
 * on every request an event organiser makes and is never more than a handful.
 * There is no down for the enum value (see SessionAdminTier).
 */
export class EventOrganisers1790150000000 implements MigrationInterface {
  name = 'EventOrganisers1790150000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."delegates_accesstier_enum" ADD VALUE IF NOT EXISTS 'event_admin'`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD COLUMN IF NOT EXISTS "managedEditionIds" uuid array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "delegates" SET "accessTier" = 'standard' WHERE "accessTier" = 'event_admin'`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN "managedEditionIds"`,
    );
  }
}
