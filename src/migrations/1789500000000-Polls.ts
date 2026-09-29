import { MigrationInterface, QueryRunner } from 'typeorm';

/** Polls fired from the stage and the one vote each delegate has on them. */
export class Polls1789500000000 implements MigrationInterface {
  name = 'Polls1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "polls_status_enum" AS ENUM ('draft', 'open', 'closed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "polls" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "editionId" uuid,
        "sessionId" uuid,
        "question" varchar(200) NOT NULL,
        "options" jsonb NOT NULL DEFAULT '[]',
        "status" "polls_status_enum" NOT NULL DEFAULT 'draft',
        "showResults" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "openedAt" timestamptz,
        "closedAt" timestamptz,
        CONSTRAINT "pk_polls" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_polls_edition" ON "polls" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "poll_votes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "pollId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "optionIndex" smallint NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_poll_votes" PRIMARY KEY ("id")
      )
    `);
    // the unique pair is what lets a second vote upsert over the first
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_poll_votes_pair" ON "poll_votes" ("pollId", "delegateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_poll_votes_poll" ON "poll_votes" ("pollId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "poll_votes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "polls"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "polls_status_enum"`);
  }
}
