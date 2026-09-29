import { MigrationInterface, QueryRunner } from 'typeorm';

export class MessageReplies1787600000000 implements MigrationInterface {
  name = 'MessageReplies1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "direct_messages" ADD "replyToId" uuid`,
    );
    /**
     * SET NULL, not CASCADE: deleting a message must not delete every reply to
     * it. A reply whose parent is gone degrades to an ordinary message.
     */
    await queryRunner.query(`
      ALTER TABLE "direct_messages"
        ADD CONSTRAINT "FK_direct_messages_reply_to"
        FOREIGN KEY ("replyToId") REFERENCES "direct_messages"("id")
        ON DELETE SET NULL
    `);
    // threads are read by pairKey; replies are looked up by parent within one
    await queryRunner.query(
      `CREATE INDEX "idx_dm_reply_to" ON "direct_messages" ("replyToId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_dm_reply_to"`);
    await queryRunner.query(
      `ALTER TABLE "direct_messages" DROP CONSTRAINT "FK_direct_messages_reply_to"`,
    );
    await queryRunner.query(
      `ALTER TABLE "direct_messages" DROP COLUMN "replyToId"`,
    );
  }
}
