import { MigrationInterface, QueryRunner } from 'typeorm';

export class Voting1786133957943 implements MigrationInterface {
  name = 'Voting1786133957943';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."pitch_entries_track_enum" AS ENUM('plenary', 'gbv', 'health', 'economic', 'innovation', 'digital', 'youth')`,
    );
    await queryRunner.query(
      `CREATE TABLE "pitch_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "innovatorName" character varying(255) NOT NULL, "country" character varying(100) NOT NULL, "track" "public"."pitch_entries_track_enum" NOT NULL, "description" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b29ce9ce432d5ac76082dd79f1b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "pitch_votes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "delegateId" character varying NOT NULL, "entryId" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_vote_delegate_entry" UNIQUE ("delegateId", "entryId"), CONSTRAINT "PK_3a05ae9654c3e2cdd760d18d341" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pitch_votes"`);
    await queryRunner.query(`DROP TABLE "pitch_entries"`);
    await queryRunner.query(`DROP TYPE "public"."pitch_entries_track_enum"`);
  }
}
