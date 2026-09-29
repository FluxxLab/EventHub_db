import { MigrationInterface, QueryRunner } from 'typeorm';

export class Notifications1786233869495 implements MigrationInterface {
  name = 'Notifications1786233869495';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "device_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "delegateId" uuid NOT NULL, "token" character varying(512) NOT NULL, "platform" character varying(20) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_977e24c520c49436d08e5eeea8a" UNIQUE ("token"), CONSTRAINT "PK_84700be257607cfb1f9dc2e52c3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_tokens_delegate" ON "device_tokens"  ("delegateId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_segment_enum" AS ENUM('all', 'vip', 'press', 'speakers', 'volunteers')`,
    );
    await queryRunner.query(
      `CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying(255) NOT NULL, "body" text NOT NULL, "segment" "public"."notifications_segment_enum" NOT NULL DEFAULT 'all', "category" character varying(255), "sentAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "tags" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delegates" DROP COLUMN "tags"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TYPE "public"."notifications_segment_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_device_tokens_delegate"`);
    await queryRunner.query(`DROP TABLE "device_tokens"`);
  }
}
