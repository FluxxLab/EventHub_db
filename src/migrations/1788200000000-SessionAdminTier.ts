import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A tier for caption operators. Postgres cannot add an enum value inside a
 * transaction on every version we might meet, so this one runs outside.
 * There is no down: removing an enum value means rebuilding the type, and
 * nothing is gained by being able to.
 */
export class SessionAdminTier1788200000000 implements MigrationInterface {
  name = 'SessionAdminTier1788200000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."delegates_accesstier_enum" ADD VALUE IF NOT EXISTS 'session_admin'`,
    );
  }

  public async down(): Promise<void> {
    // intentionally empty - see above
  }
}
