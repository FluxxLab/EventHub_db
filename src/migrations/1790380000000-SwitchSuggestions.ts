import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Switch suggestions (21 Oct 2026): the AI's suggestions that a room's next
 * session has started or its live one ended, and how each was answered.
 */
export class SwitchSuggestions1790380000000 implements MigrationInterface {
  name = 'SwitchSuggestions1790380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "switch_suggestions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "room" character varying(255) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "fromSessionId" uuid NOT NULL,
        "toSessionId" uuid,
        "confidence" real NOT NULL,
        "evidence" text NOT NULL,
        "reason" character varying(300) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'open',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_switch_suggestions" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_switch_suggestion_room_status" ON "switch_suggestions" ("room", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_switch_suggestion_room_status"`);
    await queryRunner.query(`DROP TABLE "switch_suggestions"`);
  }
}
