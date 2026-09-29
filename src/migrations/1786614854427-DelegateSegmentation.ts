import { MigrationInterface, QueryRunner } from 'typeorm';

export class DelegateSegmentation1786614854427 implements MigrationInterface {
  name = 'DelegateSegmentation1786614854427';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "tracks" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "interests" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "consentAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "consentAt"`);
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "interests"`);
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "tracks"`);
  }
}
