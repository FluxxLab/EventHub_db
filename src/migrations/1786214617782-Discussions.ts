import { MigrationInterface, QueryRunner } from 'typeorm';

export class Discussions1786214617782 implements MigrationInterface {
  name = 'Discussions1786214617782';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "session_comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sessionId" uuid NOT NULL, "authorId" uuid NOT NULL, "body" character varying(2000) NOT NULL, "flagged" boolean NOT NULL DEFAULT false, "hiddenAt" TIMESTAMP WITH TIME ZONE, "hiddenBy" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d2ff64080a5e4ec4acdc20562ad" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_comments_session_created" ON "session_comments"  ("sessionId", "createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_comments_session_created"`,
    );
    await queryRunner.query(`DROP TABLE "session_comments"`);
  }
}
