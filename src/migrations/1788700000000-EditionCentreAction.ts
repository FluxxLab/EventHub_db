import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the app's centre tab-bar button opens, per edition.
 *
 * Defaults to the delegate's access pass, which is what the organisers asked
 * for after the summit: the Innovation Hub was a two-day surface, the pass is
 * opened all day every day.
 *
 * 'pass' and 'qr' are different screens and both are wanted: 'pass' is the
 * signed credential shown at a door (FR-07), 'qr' is the networking code
 * another delegate scans to connect, which lives under Profile.
 */
export class EditionCentreAction1788700000000 implements MigrationInterface {
  name = 'EditionCentreAction1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."editions_centreaction_enum" AS ENUM
          ('pass', 'qr', 'connect', 'scan', 'innovation', 'networking', 'trivia', 'none');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "editions"
      ADD COLUMN IF NOT EXISTS "centreAction" "public"."editions_centreaction_enum"
      NOT NULL DEFAULT 'pass'
    `);

    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "centreLabel" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "centreLabel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "centreAction"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."editions_centreaction_enum"`,
    );
  }
}
