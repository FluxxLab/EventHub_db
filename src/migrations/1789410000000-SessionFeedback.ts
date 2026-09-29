import { MigrationInterface, QueryRunner } from 'typeorm';

/** One rating per delegate per session (post-summit report, XV.2). */
export class SessionFeedback1789410000000 implements MigrationInterface {
  name = 'SessionFeedback1789410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "session_feedback" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "rating" smallint NOT NULL,
        "comment" varchar(280),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_session_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "chk_session_feedback_rating" CHECK ("rating" BETWEEN 1 AND 5)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_feedback_session" ON "session_feedback" ("sessionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_session_feedback_unique" ON "session_feedback" ("sessionId", "delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "session_feedback"`);
  }
}
