import { MigrationInterface, QueryRunner } from 'typeorm';

export class Registration1786377262846 implements MigrationInterface {
  name = 'Registration1786377262846';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."registration_entries_assignedtier_enum" AS ENUM('standard', 'vip', 'vvip', 'press', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TABLE "registration_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(255), "inviteCode" character varying(50), "name" character varying(255), "assignedTier" "public"."registration_entries_assignedtier_enum" NOT NULL DEFAULT 'standard', "claimedAt" TIMESTAMP WITH TIME ZONE, "claimedByDelegateId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_fd14d8ccdb283314221d1f0e149" UNIQUE ("email"), CONSTRAINT "UQ_7d80cccde599117a17134662a22" UNIQUE ("inviteCode"), CONSTRAINT "PK_5c278002a8306c3504b62daf7ae" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_registration_entry_delegate" ON "registration_entries"  ("email") `,
    );
    await queryRunner.query(
      `ALTER TABLE "delegates" ADD "pendingReview" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delegates" DROP COLUMN "pendingReview"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_registration_entry_delegate"`,
    );
    await queryRunner.query(`DROP TABLE "registration_entries"`);
    await queryRunner.query(
      `DROP TYPE "public"."registration_entries_assignedtier_enum"`,
    );
  }
}
