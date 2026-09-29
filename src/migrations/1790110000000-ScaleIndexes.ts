import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the lookups that run on every render at summit scale (~3,000
 * delegates). Each one covers a foreign key or WHERE column that was only
 * reachable through a composite index led by a different column, so Postgres
 * fell back to scanning the table:
 *
 *  - session_bookmarks / session_attendance by "sessionId": the edition
 *    audience walks from an edition's sessions into these (the unique keys
 *    lead with "delegateId").
 *  - pitch_votes by "topicId", trivia_answers by "questionId": tallies per
 *    topic / question (unique keys lead with "delegateId").
 *  - direct_messages unread per recipient, partial on "readAt" IS NULL and
 *    carrying "pairKey" so the conversations list's grouped unread count is
 *    answered from the index alone.
 *  - notification_reads by "notificationId" (the pair index leads with
 *    "delegateId"), and the inbox's broadcast query by segment, newest first.
 *  - Trigram GIN on delegates name / organisation for the directory's
 *    `ILIKE '%q%'`, which no btree can serve. Needs pg_trgm; where the role
 *    may not create extensions the migration carries on without them rather
 *    than failing the deploy, and the directory keeps working unindexed.
 *
 * Plain CREATE INDEX (not CONCURRENTLY): TypeORM runs migrations in a
 * transaction, and at this size each build takes well under a second. All
 * idempotent, so a partially applied run can be re-run.
 */
export class ScaleIndexes1790110000000 implements MigrationInterface {
  name = 'ScaleIndexes1790110000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_bookmarks_session" ON "session_bookmarks" ("sessionId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_attendance_session" ON "session_attendance" ("sessionId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_pitch_votes_topic" ON "pitch_votes" ("topicId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_trivia_answers_question" ON "trivia_answers" ("questionId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_dm_unread_recipient" ON "direct_messages" ("recipientId", "pairKey") WHERE "readAt" IS NULL`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_notification_reads_notification" ON "notification_reads" ("notificationId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_notifications_broadcast_inbox" ON "notifications" ("segment", "sentAt" DESC) WHERE "delegateId" IS NULL AND "sentAt" IS NOT NULL`,
    );

    await q.query(`
      DO $$ BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'pg_trgm not available to this role; skipping trigram indexes';
      END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
          CREATE INDEX IF NOT EXISTS "idx_delegates_name_trgm"
            ON "delegates" USING gin ("name" gin_trgm_ops);
          CREATE INDEX IF NOT EXISTS "idx_delegates_organisation_trgm"
            ON "delegates" USING gin ("organisation" gin_trgm_ops);
        END IF;
      END $$;
    `);
  }

  /** Drops the indexes. pg_trgm stays: other objects may depend on it. */
  public async down(q: QueryRunner): Promise<void> {
    for (const name of [
      'idx_delegates_organisation_trgm',
      'idx_delegates_name_trgm',
      'idx_notifications_broadcast_inbox',
      'idx_notification_reads_notification',
      'idx_dm_unread_recipient',
      'idx_trivia_answers_question',
      'idx_pitch_votes_topic',
      'idx_attendance_session',
      'idx_bookmarks_session',
    ]) {
      await q.query(`DROP INDEX IF EXISTS "public"."${name}"`);
    }
  }
}
