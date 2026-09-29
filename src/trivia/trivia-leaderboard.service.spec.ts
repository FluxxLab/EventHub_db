import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { STAFF_TIERS } from '../delegate/entities/delegate.entity';
import {
  HIDDEN_NAME,
  TriviaLeaderboardService,
} from './trivia-leaderboard.service';

/** The sorted-set commands the board uses, in memory. */
class ZsetRedis {
  readonly zsets = new Map<string, Map<string, number>>();
  readonly strings = new Map<string, string>();

  exists(key: string) {
    return Promise.resolve(
      this.strings.has(key) || this.zsets.has(key) ? 1 : 0,
    );
  }
  zadd(key: string, ...args: (string | number)[]) {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    for (let i = 0; i < args.length; i += 2)
      z.set(String(args[i + 1]), Number(args[i]));
    this.zsets.set(key, z);
    return Promise.resolve(args.length / 2);
  }
  del(key: string) {
    this.zsets.delete(key);
    this.strings.delete(key);
    return Promise.resolve(1);
  }
  expire() {
    return Promise.resolve(1);
  }
  set(key: string, value: string) {
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }
  private sorted(key: string) {
    // Redis orders equal scores by member, descending for ZREVRANGE
    return [...(this.zsets.get(key) ?? new Map<string, number>())].sort(
      (a, b) => b[1] - a[1] || b[0].localeCompare(a[0]),
    );
  }
  zrevrange(key: string, start: number, stop: number) {
    return Promise.resolve(
      this.sorted(key)
        .slice(start, stop + 1)
        .flatMap(([m, s]) => [m, String(s)]),
    );
  }
  zcard(key: string) {
    return Promise.resolve(this.zsets.get(key)?.size ?? 0);
  }
  zscore(key: string, member: string) {
    const s = this.zsets.get(key)?.get(member);
    return Promise.resolve(s === undefined ? null : String(s));
  }
  zcount(key: string, min: string) {
    const floor = Number(min.replace('(', ''));
    return Promise.resolve(
      this.sorted(key).filter(([, s]) => s > floor).length,
    );
  }
  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain = {
      del: (k: string) => (queued.push(() => this.del(k)), chain),
      zadd: (k: string, ...a: (string | number)[]) => (
        queued.push(() => this.zadd(k, ...a)),
        chain
      ),
      expire: () => chain,
      set: (k: string, v: string) => (queued.push(() => this.set(k, v)), chain),
      exec: async () => {
        for (const run of queued) await run();
        return [];
      },
    };
    return chain;
  }
}

function build(
  totals: { delegateId: string; score: number }[],
  people: { id: string; name: string; directoryVisible: boolean }[],
) {
  const redis = new ZsetRedis();
  const query = jest.fn((sql: string) =>
    Promise.resolve(sql.includes('SUM(') ? totals : people),
  );
  const service = new TriviaLeaderboardService(
    redis as unknown as Redis,
    { query } as unknown as DataSource,
  );
  return { service, redis, query };
}

describe('TriviaLeaderboardService', () => {
  const totals = [
    { delegateId: 'd1', score: 290 },
    { delegateId: 'd2', score: 245 },
    { delegateId: 'd3', score: 245 },
    { delegateId: 'd4', score: 100 },
    { delegateId: 'd5', score: 0 },
  ];
  const people = [
    { id: 'd1', name: 'Ada', directoryVisible: true },
    { id: 'd2', name: 'Bola', directoryVisible: true },
    { id: 'd3', name: 'Chi', directoryVisible: false },
    { id: 'd4', name: 'Dayo', directoryVisible: true },
  ];

  it('builds from the Postgres totals on first read, leaving console accounts out', async () => {
    const { service, query } = build(totals, people);
    await service.top('gs27');
    await service.top('gs27');
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    const sums = calls.filter(([sql]) => sql.includes('SUM('));
    expect(sums).toHaveLength(1); // built once, then read from Redis
    expect(sums[0][1]).toEqual(['gs27', STAFF_TIERS]);
  });

  it('ranks ties together and skips the next rank', async () => {
    const { service } = build(totals, people);
    const board = await service.top('gs27', 4);
    expect(board.players).toBe(5);
    expect(board.top.map((r) => [r.rank, r.score])).toEqual([
      [1, 290],
      [2, 245],
      [2, 245],
      [4, 100],
    ]);
  });

  it('does not name or identify a delegate hidden from the directory', async () => {
    const { service } = build(totals, people);
    const board = await service.top('gs27');
    const hidden = board.top.find((r) => r.name === HIDDEN_NAME);
    expect(hidden).toMatchObject({ delegateId: null, score: 245 });
    expect(board.top.some((r) => r.name === 'Chi')).toBe(false);
  });

  it('gives a delegate their own rank and score, and none before they have played', async () => {
    const { service } = build(totals, people);
    await expect(service.standing('gs27', 'd3')).resolves.toEqual({
      rank: 2,
      score: 245,
      players: 5,
    });
    await expect(service.standing('gs27', 'd5')).resolves.toEqual({
      rank: 5,
      score: 0,
      players: 5,
    });
    await expect(service.standing('gs27', 'nobody')).resolves.toEqual({
      rank: null,
      score: 0,
      players: 5,
    });
  });

  it('keeps each event on its own board', async () => {
    const { service, redis } = build(totals, people);
    await service.rebuild('gs27');
    await service.rebuild(null);
    expect(redis.zsets.has(TriviaLeaderboardService.key('gs27'))).toBe(true);
    expect(redis.zsets.has(TriviaLeaderboardService.key(null))).toBe(true);
    expect(TriviaLeaderboardService.key('gs27')).not.toBe(
      TriviaLeaderboardService.key(null),
    );
  });
});
