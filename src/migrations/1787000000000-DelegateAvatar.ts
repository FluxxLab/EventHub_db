import { MigrationInterface, QueryRunner } from 'typeorm';

export class DelegateAvatar1787000000000 implements MigrationInterface {
  name = 'DelegateAvatar1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "avatarUrl" character varying(512)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "avatarUrl"`);
  }
}
