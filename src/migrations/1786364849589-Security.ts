import { MigrationInterface, QueryRunner } from 'typeorm';

export class Security1786364849589 implements MigrationInterface {
  name = 'Security1786364849589';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."security_severity_enum" AS ENUM('info', 'warning', 'critical')`,
    );
    await queryRunner.query(
      `CREATE TABLE "security" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(255) NOT NULL, "description" text NOT NULL, "actionId" uuid, "severity" "public"."security_severity_enum" NOT NULL DEFAULT 'info', "metadata" json, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_148e8beb2eb8f65efdb658cb3fd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_security_events_created" ON "security"  ("createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_security_events_created"`,
    );
    await queryRunner.query(`DROP TABLE "security"`);
    await queryRunner.query(`DROP TYPE "public"."security_severity_enum"`);
  }
}
