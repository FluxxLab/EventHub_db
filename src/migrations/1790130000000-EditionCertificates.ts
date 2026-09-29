import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Certificates per edition, from artwork the organisers upload.
 *
 * - editions.certificateTemplate: the artwork and where the name and code go.
 * - certificates.editionId: which summit a certificate is for. One per
 *   delegate per edition, instead of one per delegate ever.
 *
 * Existing certificates were all issued for the first summit (GS-26), so they
 * are attached to the earliest edition. Their codes are unchanged and still
 * verify.
 */
export class EditionCertificates1790130000000 implements MigrationInterface {
  name = 'EditionCertificates1790130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "editions" ADD COLUMN IF NOT EXISTS "certificateTemplate" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "editionId" uuid`,
    );
    await queryRunner.query(
      `UPDATE "certificates" SET "editionId" = (SELECT "id" FROM "editions" ORDER BY "createdAt" ASC LIMIT 1) WHERE "editionId" IS NULL`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_certificates_delegate"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_certificates_delegate_edition" ON "certificates" ("delegateId", "editionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_certificates_delegate_edition"`,
    );
    // Only safe when each delegate holds one certificate; with several editions, this fails loudly rather than choosing one.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_certificates_delegate" ON "certificates" ("delegateId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "certificates" DROP COLUMN IF EXISTS "editionId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" DROP COLUMN IF EXISTS "certificateTemplate"`,
    );
  }
}
