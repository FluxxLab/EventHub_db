import { MigrationInterface, QueryRunner } from 'typeorm';

export class DelegateBlocks1787800000000 implements MigrationInterface {
  name = 'DelegateBlocks1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "delegate_blocks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "blockerId" uuid NOT NULL,
        "blockedId" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_delegate_blocks" PRIMARY KEY ("id")
      )
    `);
    // one row per pair-direction, enforced by the database not the service
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_delegate_blocks_unique"
        ON "delegate_blocks" ("blockerId", "blockedId")
    `);
    // enforcement checks both directions, so the reverse lookup needs an index too
    await queryRunner.query(`
      CREATE INDEX "idx_delegate_blocks_blocked"
        ON "delegate_blocks" ("blockedId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "delegate_blocks"`);
  }
}
