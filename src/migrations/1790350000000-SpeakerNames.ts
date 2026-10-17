import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Speaker naming (17 Oct 2026): who a diarised voice or a mic was for a
 * stretch of a session, heard from introductions, typed by an operator or
 * found by a whole-session review; and each event's setting for how far the
 * captions go in naming people on their own.
 */
export class SpeakerNames1790350000000 implements MigrationInterface {
  name = 'SpeakerNames1790350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."speaker_names_kind_enum" AS ENUM('speaker', 'mic')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."speaker_names_status_enum" AS ENUM('auto', 'suggested', 'confirmed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."speaker_names_source_enum" AS ENUM('introduction', 'operator', 'review')`,
    );
    await queryRunner.query(
      `CREATE TABLE "speaker_names" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sessionId" character varying(255) NOT NULL,
        "kind" "public"."speaker_names_kind_enum" NOT NULL,
        "key" smallint NOT NULL,
        "name" character varying(255) NOT NULL,
        "organisation" character varying(255),
        "speakerId" uuid,
        "status" "public"."speaker_names_status_enum" NOT NULL,
        "source" "public"."speaker_names_source_enum" NOT NULL,
        "evidence" text,
        "fromAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "toAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_speaker_names" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_speaker_name_session" ON "speaker_names" ("sessionId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ADD "speakerNaming" character varying(16) NOT NULL DEFAULT 'programme'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN "speakerNaming"`,
    );
    await queryRunner.query(`DROP INDEX "idx_speaker_name_session"`);
    await queryRunner.query(`DROP TABLE "speaker_names"`);
    await queryRunner.query(`DROP TYPE "public"."speaker_names_source_enum"`);
    await queryRunner.query(`DROP TYPE "public"."speaker_names_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."speaker_names_kind_enum"`);
  }
}
