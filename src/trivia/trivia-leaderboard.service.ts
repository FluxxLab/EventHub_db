import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '../common/redis/redis.module';
import { STAFF_TIERS } from '../delegate/entities/delegate.entity';

/** Rows on the board a phone is sent. */
export const LEADERBOARD_TOP = 10;
/** The board is rebuilt on every close; this only collects forgotten events. */
const BOARD_TTL_SECONDS = 14 * 24 * 60 * 60;
/** ZADD arguments per command when rebuilding, so one event cannot build a huge command. */
const ZADD_CHUNK = 500;
/** How a delegate who hid themselves from the directory appears on the board. */
export const HIDDEN_NAME = 'A delegate';

export interface Standing {
  /** Competition ranking: equal scores share a rank, the next rank skips. */
  rank: number;
  /** Null for a delegate hidden from the directory. */
  delegateId: string | null;
  name: string;
  score: number;
}

export interface Leaderboard {
  editionId: string | null;
  /** Delegates with at least one scored answer in this event. */
  players: number;
  top: Standing[];
}

export interface MyStanding {
  /** Null until the delegate has a scored answer in this event. */
  rank: number | null;
  score: number;
  players: number;
}

/**
 * Per-event trivia totals, as a Redis sorted set per edition.
 *
 * Postgres stays the source of truth: every answer carries its points once
 * its question closes, and the set is rebuilt from `SUM(points)` for the
 * event on each close (and whenever it is missing). That is one aggregate per
 * question, not a write per answer, so the tally-per-answer machinery the
 * distribution uses is not needed here - the board only moves at a close.
 *
 * Reads are what is hot: a whole room asks for its rank the moment a
 * question closes, and ZREVRANGE / ZSCORE / ZCOUNT answer that without
 * touching Postgres.
 *
 * Console accounts (organisers, operators) can play but are not ranked.
 */
@Injectable()
export class TriviaLeaderboardService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  static key(editionId: string | null): string {
    return `trivia:board:${editionId ?? 'none'}`;
  }

  private static builtKey(editionId: string | null): string {
    return `${TriviaLeaderboardService.key(editionId)}:built`;
  }

  /** Recounts the event's totals from Postgres and replaces the set. */
  async rebuild(editionId: string | null): Promise<void> {
    const rows = await this.dataSource.query<
      { delegateId: string; score: number | string }[]
    >(
      `SELECT a."delegateId" AS "delegateId", SUM(a."points")::int AS "score"
         FROM "trivia_answers" a
         JOIN "trivia_questions" q ON q."id" = a."questionId"
         JOIN "delegates" d ON d."id" = a."delegateId"
        WHERE ${editionId ? `q."editionId" = $1` : `q."editionId" IS NULL`}
          AND q."status" = 'closed'
          AND a."points" IS NOT NULL
          AND d."accessTier"::text <> ALL(${editionId ? '$2' : '$1'}::text[])
        GROUP BY a."delegateId"`,
      editionId ? [editionId, STAFF_TIERS] : [STAFF_TIERS],
    );

    const key = TriviaLeaderboardService.key(editionId);
    const multi = this.redis.multi();
    multi.del(key);
    for (let i = 0; i < rows.length; i += ZADD_CHUNK) {
      const args: (string | number)[] = [];
      for (const row of rows.slice(i, i + ZADD_CHUNK))
        args.push(Number(row.score), row.delegateId);
      multi.zadd(key, ...args);
    }
    multi.expire(key, BOARD_TTL_SECONDS);
    multi.set(
      TriviaLeaderboardService.builtKey(editionId),
      '1',
      'EX',
      BOARD_TTL_SECONDS,
    );
    await multi.exec();
  }

  /** Builds the set if this instance finds it missing (cold Redis, expiry). */
  private async ensure(editionId: string | null): Promise<void> {
    if (await this.redis.exists(TriviaLeaderboardService.builtKey(editionId)))
      return;
    await this.rebuild(editionId);
  }

  /** The top of the board, ranked, with names. */
  async top(
    editionId: string | null,
    limit = LEADERBOARD_TOP,
  ): Promise<Leaderboard> {
    await this.ensure(editionId);
    const key = TriviaLeaderboardService.key(editionId);
    const [flat, players] = await Promise.all([
      this.redis.zrevrange(key, 0, limit - 1, 'WITHSCORES'),
      this.redis.zcard(key),
    ]);

    const pairs: { delegateId: string; score: number }[] = [];
    for (let i = 0; i < flat.length; i += 2)
      pairs.push({ delegateId: flat[i], score: Number(flat[i + 1]) });

    const names = await this.names(pairs.map((p) => p.delegateId));
    let rank = 0;
    const top = pairs.map((p, index) => {
      // the list is sorted, so a score equal to the one above shares its rank
      if (index === 0 || p.score !== pairs[index - 1].score) rank = index + 1;
      const who = names.get(p.delegateId);
      const visible = who?.visible ?? false;
      return {
        rank,
        delegateId: visible ? p.delegateId : null,
        name: visible ? (who?.name ?? HIDDEN_NAME) : HIDDEN_NAME,
        score: p.score,
      };
    });
    return { editionId, players: Number(players), top };
  }

  /** One delegate's total and rank in the event. */
  async standing(
    editionId: string | null,
    delegateId: string,
  ): Promise<MyStanding> {
    await this.ensure(editionId);
    const key = TriviaLeaderboardService.key(editionId);
    const [raw, players] = await Promise.all([
      this.redis.zscore(key, delegateId),
      this.redis.zcard(key),
    ]);
    if (raw === null) return { rank: null, score: 0, players: Number(players) };
    const score = Number(raw);
    // rank = everyone strictly ahead, plus one: ties share a rank
    const ahead = await this.redis.zcount(key, `(${score}`, '+inf');
    return { rank: Number(ahead) + 1, score, players: Number(players) };
  }

  private async names(
    ids: string[],
  ): Promise<Map<string, { name: string; visible: boolean }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource.query<
      { id: string; name: string; directoryVisible: boolean }[]
    >(
      `SELECT "id", "name", "directoryVisible" FROM "delegates" WHERE "id" = ANY($1)`,
      [ids],
    );
    return new Map(
      rows.map((r) => [r.id, { name: r.name, visible: r.directoryVisible }]),
    );
  }
}
