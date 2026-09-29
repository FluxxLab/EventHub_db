import { MigrationInterface, QueryRunner } from 'typeorm';

export class Delegates1785767400991 implements MigrationInterface {
  name = 'Delegates1785767400991';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."delegates_accesstier_enum" AS ENUM('standard', 'vip', 'vvip', 'press', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TABLE "delegates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(255) NOT NULL, "passwordHash" character varying(255) NOT NULL, "name" character varying(255) NOT NULL, "accessTier" "public"."delegates_accesstier_enum" NOT NULL DEFAULT 'standard', "title" character varying(100), "track" character varying(100), "organisation" character varying(255), "country" character varying(100), "flagged" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_ac6794290827f5c8d31504aafc2" UNIQUE ("email"), CONSTRAINT "PK_082736acecbc28020d855c5aa07" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "userAgent" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "ip" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "ip" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "userAgent" SET NOT NULL`,
    );
    await queryRunner.query(`DROP TABLE "delegates"`);
    await queryRunner.query(`DROP TYPE "public"."delegates_accesstier_enum"`);
  }
}
