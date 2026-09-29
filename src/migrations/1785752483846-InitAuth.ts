import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitAuth1785752483846 implements MigrationInterface {
  name = 'InitAuth1785752483846';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "jti" character varying(255) NOT NULL, "userId" character varying(255) NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "replacedByJti" character varying(255), "consumedAt" TIMESTAMP, "userAgent" character varying(255) NOT NULL, "ip" character varying(255) NOT NULL, "revokedAt" TIMESTAMP, CONSTRAINT "UQ_f3752400c98d5c0b3dca54d66d5" UNIQUE ("jti"), CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_user_expires" ON "refresh_tokens"  ("userId", "expiresAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_refresh_tokens_user_expires"`,
    );
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
