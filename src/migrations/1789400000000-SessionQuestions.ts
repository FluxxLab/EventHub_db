import { MigrationInterface, QueryRunner } from 'typeorm';

/** Questions from the floor and the upvotes on them (post-summit report, XV.1). */
export class SessionQuestions1789400000000 implements MigrationInterface {
  name = 'SessionQuestions1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "session_questions_status_enum" AS ENUM ('open', 'answered', 'dismissed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "session_questions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "text" varchar(280) NOT NULL,
        "status" "session_questions_status_enum" NOT NULL DEFAULT 'open',
        "upvotes" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "answeredAt" timestamptz,
        CONSTRAINT "pk_session_questions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_questions_session" ON "session_questions" ("sessionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "question_votes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "questionId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_question_votes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_question_votes_unique" ON "question_votes" ("questionId", "delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "question_votes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "session_questions"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "session_questions_status_enum"`,
    );
  }
}
