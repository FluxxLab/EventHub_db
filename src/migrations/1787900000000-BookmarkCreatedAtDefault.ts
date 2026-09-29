import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * session_bookmarks.createdAt was created NOT NULL with no default, so any
 * insert that did not name it (the bookmark endpoint's did not) failed with
 * a null-constraint violation. The service now sets it explicitly; this
 * default makes the column safe for any future writer as well.
 */
export class BookmarkCreatedAtDefault1787900000000 implements MigrationInterface {
  name = 'BookmarkCreatedAtDefault1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_bookmarks" ALTER COLUMN "createdAt" SET DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_bookmarks" ALTER COLUMN "createdAt" DROP DEFAULT`,
    );
  }
}
