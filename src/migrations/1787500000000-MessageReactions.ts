import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Timestamp is deliberately 1787500000000, not 1787400000000: CommentVotes and
 * SummitTracks already collide on that value, and TypeORM orders migrations by
 * it. Adding a third would make the run order of all three depend on filesystem
 * iteration - fine locally, not fine on a fresh CI database.
 */
export class MessageReactions1787500000000 implements MigrationInterface {
  name = 'MessageReactions1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "message_reactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "messageId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "emoji" character varying(16) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_reactions" PRIMARY KEY ("id")
      )
    `);
    // one reaction per delegate per message, enforced by the database
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_message_reactions_unique"
        ON "message_reactions" ("messageId", "delegateId")
    `);
    // reactions die with their message, and with the account that left them
    await queryRunner.query(`
      ALTER TABLE "message_reactions"
        ADD CONSTRAINT "FK_message_reactions_message"
        FOREIGN KEY ("messageId") REFERENCES "direct_messages"("id")
        ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "message_reactions"`);
  }
}
