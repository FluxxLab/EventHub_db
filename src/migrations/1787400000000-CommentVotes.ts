import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommentVotes1787400000000 implements MigrationInterface {
  name = 'CommentVotes1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_comments" ADD "likes" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_comments" ADD "dislikes" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      CREATE TABLE "comment_votes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "commentId" uuid NOT NULL,
        "delegateId" uuid NOT NULL,
        "value" character varying(10) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_comment_votes" PRIMARY KEY ("id")
      )
    `);
    /**
     * The rule "one vote per delegate per comment" lives here rather than in a
     * service-side check, so two simultaneous taps cannot both insert.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_comment_votes_unique"
        ON "comment_votes" ("commentId", "delegateId")
    `);
    /**
     * Votes die with their comment. Without this a deleted comment leaves rows
     * that count towards nothing and can never be cleaned up by delegate.
     */
    await queryRunner.query(`
      ALTER TABLE "comment_votes"
        ADD CONSTRAINT "FK_comment_votes_comment"
        FOREIGN KEY ("commentId") REFERENCES "session_comments"("id")
        ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "comment_votes"`);
    await queryRunner.query(
      `ALTER TABLE "session_comments" DROP COLUMN "dislikes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "session_comments" DROP COLUMN "likes"`,
    );
  }
}
