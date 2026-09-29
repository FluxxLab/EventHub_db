import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Photo galleries and the learning library (26 Sep 2026). Both are new app
 * features, on for every edition: the console has no feature switches, and
 * the app shows a friendly empty page until organisers add something.
 */
export class GalleryAndLibrary1790220000000 implements MigrationInterface {
  name = 'GalleryAndLibrary1790220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "gallery_albums" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "title" varchar(120) NOT NULL,
        "description" varchar(500),
        "coverPhotoId" uuid,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isPublished" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gallery_albums" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gallery_albums_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_gallery_albums_edition" ON "gallery_albums" ("editionId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "gallery_photos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "albumId" uuid NOT NULL,
        "editionId" uuid NOT NULL,
        "key" varchar(255) NOT NULL,
        "thumbKey" varchar(255) NOT NULL,
        "width" integer NOT NULL,
        "height" integer NOT NULL,
        "sizeBytes" integer NOT NULL,
        "caption" varchar(300),
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gallery_photos" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gallery_photos_album" FOREIGN KEY ("albumId") REFERENCES "gallery_albums"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_gallery_photos_album" ON "gallery_photos" ("albumId", "sortOrder")`,
    );
    await queryRunner.query(`
      CREATE TABLE "library_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "editionId" uuid NOT NULL,
        "title" varchar(200) NOT NULL,
        "description" varchar(1000),
        "kind" varchar(10) NOT NULL,
        "url" varchar(1000) NOT NULL,
        "topic" varchar(80),
        "sizeLabel" varchar(20),
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isPublished" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_library_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_library_items_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_library_items_edition" ON "library_items" ("editionId", "sortOrder")`,
    );
    // the two features: on for new editions, and for every edition there is
    await queryRunner.query(
      `ALTER TABLE "editions" ALTER COLUMN "features" SET DEFAULT '{schedule,speakers,venue,notifications,resources,captions,audio,questions,materials,feedback,polls,passport,gallery,library}'`,
    );
    await queryRunner.query(
      `UPDATE "editions" SET "features" = array_append("features", 'gallery') WHERE NOT ('gallery' = ANY("features"))`,
    );
    await queryRunner.query(
      `UPDATE "editions" SET "features" = array_append("features", 'library') WHERE NOT ('library' = ANY("features"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "editions" SET "features" = array_remove(array_remove("features", 'gallery'), 'library')`,
    );
    await queryRunner.query(
      `ALTER TABLE "editions" ALTER COLUMN "features" SET DEFAULT '{schedule,speakers,venue,notifications,resources,captions,audio,questions,materials,feedback,polls,passport}'`,
    );
    await queryRunner.query(`DROP TABLE "library_items"`);
    await queryRunner.query(`DROP TABLE "gallery_photos"`);
    await queryRunner.query(`DROP TABLE "gallery_albums"`);
  }
}
