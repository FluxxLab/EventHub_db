import { MigrationInterface, QueryRunner } from 'typeorm';

/** Slides, papers, communiques and links attached to a session (post-summit report, XV.3). */
export class SessionMaterials1789420000000 implements MigrationInterface {
  name = 'SessionMaterials1789420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "session_materials_kind_enum" AS ENUM ('slides', 'paper', 'communique', 'recording', 'link', 'other');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "session_materials" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL,
        "title" varchar(200) NOT NULL,
        "url" varchar(1000) NOT NULL,
        "kind" "session_materials_kind_enum" NOT NULL DEFAULT 'other',
        "sizeLabel" varchar(20),
        "sortOrder" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_session_materials" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_session_materials_session" ON "session_materials" ("sessionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "session_materials"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "session_materials_kind_enum"`,
    );
  }
}
