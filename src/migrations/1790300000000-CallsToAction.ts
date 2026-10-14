import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Calls to action (14 Oct 2026): what each session asked an organisation or
 * group to commit to, suggested by analysing its named transcript and
 * reviewed by organisers; and how far each session has been analysed.
 */
export class CallsToAction1790300000000 implements MigrationInterface {
  name = 'CallsToAction1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "calls_to_action" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "sessionId" uuid,
        "type" varchar(20) NOT NULL DEFAULT 'recommendation',
        "action" text NOT NULL,
        "shortText" varchar(200) NOT NULL,
        "directedAt" varchar(200) NOT NULL,
        "proposedBy" varchar(200),
        "proposedByOrganisation" varchar(200),
        "alsoProposedBy" text[] NOT NULL DEFAULT '{}',
        "deadline" varchar(120),
        "amount" varchar(120),
        "theme" varchar(120),
        "quote" text,
        "saidAt" timestamptz,
        "needsDetail" boolean NOT NULL DEFAULT false,
        "status" varchar(12) NOT NULL DEFAULT 'suggested',
        "mergedInto" uuid,
        "source" varchar(10) NOT NULL DEFAULT 'ai',
        "reviewedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_calls_to_action" PRIMARY KEY ("id"),
        CONSTRAINT "FK_calls_to_action_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_calls_to_action_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_calls_to_action_edition" ON "calls_to_action" ("editionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_calls_to_action_session" ON "calls_to_action" ("sessionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "session_analyses" (
        "sessionId" uuid NOT NULL,
        "analysedUpTo" timestamptz NOT NULL,
        "runs" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_session_analyses" PRIMARY KEY ("sessionId"),
        CONSTRAINT "FK_session_analyses_session" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "session_analyses"`);
    await queryRunner.query(`DROP TABLE "calls_to_action"`);
  }
}
