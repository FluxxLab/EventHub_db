import { MigrationInterface, QueryRunner } from 'typeorm';

export class DelegatePhone1786419270642 implements MigrationInterface {
  name = 'DelegatePhone1786419270642';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "phone" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "phone"`);
  }
}
