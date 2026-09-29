import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The registration list already knows where an invitee works and what they
 * do; the sign-up form was asking them to type it again. Stored on the entry
 * so the app can prefill from an invite code and registration can copy it
 * onto the delegate.
 */
export class RegistrationEntryProfile1789610000000 implements MigrationInterface {
  name = 'RegistrationEntryProfile1789610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "registration_entries" ADD COLUMN IF NOT EXISTS "organisation" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "registration_entries" ADD COLUMN IF NOT EXISTS "title" varchar(100)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "registration_entries" DROP COLUMN IF EXISTS "title"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registration_entries" DROP COLUMN IF EXISTS "organisation"`,
    );
  }
}
