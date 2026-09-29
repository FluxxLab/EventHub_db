import { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentsAndCertificates1787100000000 implements MigrationInterface {
  name = 'DocumentsAndCertificates1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_documents" (
        "key" character varying(64) NOT NULL,
        "title" character varying(255) NOT NULL,
        "url" character varying(512) NOT NULL,
        "sizeLabel" character varying(32),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_documents" PRIMARY KEY ("key")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "certificates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "delegateId" uuid NOT NULL,
        "code" character varying(32) NOT NULL,
        "delegateName" character varying(255) NOT NULL,
        "issuedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_certificates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_certificates_code" UNIQUE ("code")
      )
    `);

    // one certificate per delegate - the issue path relies on this
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_certificates_delegate" ON "certificates" ("delegateId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_certificates_delegate"`);
    await queryRunner.query(`DROP TABLE "certificates"`);
    await queryRunner.query(`DROP TABLE "app_documents"`);
  }
}
