import { MigrationInterface, QueryRunner } from 'typeorm';

/** Venue coordinates, for the app's "nearby" sort. Null until the console sets them. */
export class EditionCoordinates1789810000000 implements MigrationInterface {
  name = 'EditionCoordinates1789810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "latitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "longitude" double precision`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "longitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "latitude"`,
    );
  }
}
