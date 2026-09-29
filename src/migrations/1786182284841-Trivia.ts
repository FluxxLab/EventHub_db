import { MigrationInterface, QueryRunner } from 'typeorm';

export class Trivia1786182284841 implements MigrationInterface {
  name = 'Trivia1786182284841';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."trivia_questions_correctoption_enum" AS ENUM('A', 'B', 'C', 'D')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."trivia_questions_status_enum" AS ENUM('draft', 'live', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "trivia_questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "text" text NOT NULL, "optionA" character varying(500) NOT NULL, "optionB" character varying(500) NOT NULL, "optionC" character varying(500) NOT NULL, "optionD" character varying(500) NOT NULL, "correctOption" "public"."trivia_questions_correctoption_enum" NOT NULL, "explanation" text, "status" "public"."trivia_questions_status_enum" NOT NULL DEFAULT 'draft', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0b531b41ee97bcd75d906f1988e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_trivia_status" ON "trivia_questions"  ("status") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."trivia_answers_chosenoption_enum" AS ENUM('A', 'B', 'C', 'D')`,
    );
    await queryRunner.query(
      `CREATE TABLE "trivia_answers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "delegateId" uuid NOT NULL, "questionId" uuid NOT NULL, "chosenOption" "public"."trivia_answers_chosenoption_enum" NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_answer_delegate_question" UNIQUE ("delegateId", "questionId"), CONSTRAINT "PK_de310287f00df923571db94c09a" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trivia_answers"`);
    await queryRunner.query(
      `DROP TYPE "public"."trivia_answers_chosenoption_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_trivia_status"`);
    await queryRunner.query(`DROP TABLE "trivia_questions"`);
    await queryRunner.query(
      `DROP TYPE "public"."trivia_questions_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."trivia_questions_correctoption_enum"`,
    );
  }
}
