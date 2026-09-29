import { MigrationInterface, QueryRunner } from 'typeorm';

export class Sessions1786017052547 implements MigrationInterface {
  name = 'Sessions1786017052547';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "speakers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "role" character varying(255), "organisation" character varying(255), "avatarUrl" character varying(255), CONSTRAINT "PK_b3818c94af77a0cf73403ecef14" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sessions_track_enum" AS ENUM('plenary', 'gbv', 'health', 'economic', 'innovation', 'digital', 'youth')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sessions_status_enum" AS ENUM('scheduled', 'live', 'completed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying(255) NOT NULL, "description" text NOT NULL, "day" integer NOT NULL, "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "track" "public"."sessions_track_enum" NOT NULL, "status" "public"."sessions_status_enum" NOT NULL, "type" character varying(255) NOT NULL, "audience" character varying(255), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_status" ON "sessions"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_session_day_track" ON "sessions"  ("day", "track") `,
    );
    await queryRunner.query(
      `CREATE TABLE "session_bookmarks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "delegateId" uuid NOT NULL, "sessionId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "uq_bookmark_delegate_session" UNIQUE ("delegateId", "sessionId"), CONSTRAINT "PK_bb26065c3b1f97e9109c6d3df93" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "session_speakers" ("sessionsId" uuid NOT NULL, "speakersId" uuid NOT NULL, CONSTRAINT "PK_c81d3baedf93a83ab6fa319dd26" PRIMARY KEY ("sessionsId", "speakersId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6e546974fe48a4d3a405cc4f9f" ON "session_speakers"  ("sessionsId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eeda40ec86f1fc7658706b1a5f" ON "session_speakers"  ("speakersId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "session_speakers" ADD CONSTRAINT "FK_6e546974fe48a4d3a405cc4f9fa" FOREIGN KEY ("sessionsId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_speakers" ADD CONSTRAINT "FK_eeda40ec86f1fc7658706b1a5fb" FOREIGN KEY ("speakersId") REFERENCES "speakers"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_speakers" DROP CONSTRAINT "FK_eeda40ec86f1fc7658706b1a5fb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_speakers" DROP CONSTRAINT "FK_6e546974fe48a4d3a405cc4f9fa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eeda40ec86f1fc7658706b1a5f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6e546974fe48a4d3a405cc4f9f"`,
    );
    await queryRunner.query(`DROP TABLE "session_speakers"`);
    await queryRunner.query(`DROP TABLE "session_bookmarks"`);
    await queryRunner.query(`DROP INDEX "public"."idx_session_day_track"`);
    await queryRunner.query(`DROP INDEX "public"."idx_session_status"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(`DROP TYPE "public"."sessions_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."sessions_track_enum"`);
    await queryRunner.query(`DROP TABLE "speakers"`);
  }
}
