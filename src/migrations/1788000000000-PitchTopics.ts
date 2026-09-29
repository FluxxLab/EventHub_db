import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pitchathon becomes a ballot rather than a like button.
 *
 * Before: a vote was (delegate, entry) and a delegate could vote for every
 * pitch, so the tally measured exposure. After: a topic holds several pitches
 * and a delegate casts one vote in each topic, changeable until the topic
 * closes.
 *
 * Existing pitch entries survive - they are content someone typed - and are
 * parked on an "Unassigned" topic for an organiser to sort. Existing votes do
 * not survive: a delegate who liked three pitches in one topic has no single
 * choice to migrate to, and a synthesised ballot would be a made-up result.
 */
export class PitchTopics1788000000000 implements MigrationInterface {
  name = 'PitchTopics1788000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "public"."pitch_topics_voting_enum" AS ENUM('pending', 'open', 'closed')`,
    );
    await q.query(
      `CREATE TABLE "pitch_topics" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(160) NOT NULL, "position" integer NOT NULL DEFAULT 0, "voting" "public"."pitch_topics_voting_enum" NOT NULL DEFAULT 'pending', "result" jsonb, "closedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_pitch_topics" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE TABLE "pitch_vote_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "delegateId" character varying NOT NULL, "topicId" uuid NOT NULL, "entryId" character varying NOT NULL, "previousEntryId" uuid, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_pitch_vote_events" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE INDEX "IDX_pitch_vote_events_topic_at" ON "pitch_vote_events" ("topicId", "at")`,
    );

    // Added nullable, backfilled, then tightened - the column is NOT NULL on
    // the entity, and an ALTER on a populated table cannot start that way.
    await q.query(`ALTER TABLE "pitch_entries" ADD "topicId" uuid`);
    await q.query(
      `INSERT INTO "pitch_topics" ("name", "position") SELECT 'Unassigned', 0 WHERE EXISTS (SELECT 1 FROM "pitch_entries")`,
    );
    await q.query(
      `UPDATE "pitch_entries" SET "topicId" = (SELECT "id" FROM "pitch_topics" WHERE "name" = 'Unassigned' LIMIT 1) WHERE "topicId" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "pitch_entries" ALTER COLUMN "topicId" SET NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "pitch_entries" ADD CONSTRAINT "FK_pitch_entries_topic" FOREIGN KEY ("topicId") REFERENCES "pitch_topics"("id") ON DELETE CASCADE`,
    );

    // Must precede the NOT NULL column below: Postgres rejects a non-nullable
    // column added to a populated table with no default.
    await q.query(`DELETE FROM "pitch_votes"`);
    await q.query(
      `ALTER TABLE "pitch_votes" DROP CONSTRAINT "uq_vote_delegate_entry"`,
    );
    await q.query(`ALTER TABLE "pitch_votes" ADD "topicId" uuid NOT NULL`);
    await q.query(
      `ALTER TABLE "pitch_votes" ADD "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await q.query(
      `ALTER TABLE "pitch_votes" ADD CONSTRAINT "uq_vote_delegate_topic" UNIQUE ("delegateId", "topicId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Ballots cannot be turned back into likes any more than the reverse.
    await q.query(`DELETE FROM "pitch_votes"`);
    await q.query(
      `ALTER TABLE "pitch_votes" DROP CONSTRAINT "uq_vote_delegate_topic"`,
    );
    await q.query(`ALTER TABLE "pitch_votes" DROP COLUMN "updatedAt"`);
    await q.query(`ALTER TABLE "pitch_votes" DROP COLUMN "topicId"`);
    await q.query(
      `ALTER TABLE "pitch_votes" ADD CONSTRAINT "uq_vote_delegate_entry" UNIQUE ("delegateId", "entryId")`,
    );

    await q.query(
      `ALTER TABLE "pitch_entries" DROP CONSTRAINT "FK_pitch_entries_topic"`,
    );
    await q.query(`ALTER TABLE "pitch_entries" DROP COLUMN "topicId"`);

    await q.query(`DROP INDEX "public"."IDX_pitch_vote_events_topic_at"`);
    await q.query(`DROP TABLE "pitch_vote_events"`);
    await q.query(`DROP TABLE "pitch_topics"`);
    await q.query(`DROP TYPE "public"."pitch_topics_voting_enum"`);
  }
}
