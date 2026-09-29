import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionRoom1786290990618 implements MigrationInterface {
  name = 'SessionRoom1786290990618';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transcript_segments_source_enum" AS ENUM('ai', 'human')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transcript_segments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sessionId" character varying(255) NOT NULL, "text" text NOT NULL, "room" character varying(255) NOT NULL, "source" "public"."transcript_segments_source_enum" NOT NULL DEFAULT 'ai', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_34cfd4b54a9857af7dfa443f3ed" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "room" character varying(255) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'scheduled'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "room"`);
    await queryRunner.query(`DROP TABLE "transcript_segments"`);
    await queryRunner.query(
      `DROP TYPE "public"."transcript_segments_source_enum"`,
    );
  }
}
