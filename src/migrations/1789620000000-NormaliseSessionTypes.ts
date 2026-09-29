import { MigrationInterface, QueryRunner } from 'typeorm';
import { normaliseSessionType } from '../sessions/session-types';

/**
 * Folds the free-text `sessions.type` values already stored onto the closed
 * list in `session-types.ts`, using the same normaliser the DTOs now apply
 * on the way in. Anything the normaliser does not recognise becomes `other`
 * rather than being left as a variant nothing can group.
 *
 * One UPDATE per distinct value, not per row: the agenda has a hundred rows
 * and a dozen spellings.
 */
export class NormaliseSessionTypes1789620000000 implements MigrationInterface {
  name = 'NormaliseSessionTypes1789620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { type: string }[] = await queryRunner.query(
      `SELECT DISTINCT "type" FROM "sessions"`,
    );
    for (const { type } of rows) {
      const canonical = normaliseSessionType(type) ?? 'other';
      if (canonical === type) continue;
      await queryRunner.query(
        `UPDATE "sessions" SET "type" = $1 WHERE "type" = $2`,
        [canonical, type],
      );
    }
  }

  /**
   * Nothing to undo: the original spellings are gone by design, and the
   * canonical values are valid under the previous schema too (the column
   * was and is free text).
   */
  public async down(): Promise<void> {}
}
