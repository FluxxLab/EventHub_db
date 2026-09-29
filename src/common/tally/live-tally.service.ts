import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/** How often, at most, one tally is broadcast across every API instance. */
export const TALLY_EMIT_WINDOW_MS = 1000;

/**
 * The deferred emit runs this long after the dirty flag's expiry. The flag is
 * set on Redis and the timer starts once Redis has answered, so waiting past
 * the flag's PX guarantees the read happens after the flag is gone: a vote
 * that found the flag still set (and so scheduled nothing) had already
 * written its count, and a vote after expiry schedules the next emit itself.
 */
const EMIT_MARGIN_MS = 50;

/**
 * Hash field marking a counts hash as seeded from Postgres. Without it a
 * hash that only holds increments (written before or without a seed) would be
 * mistaken for the full count. Never returned by `read`.
 */
const SEEDED_FIELD = '__seeded';

/** Counts are live display state; this only collects forgotten keys. */
const COUNTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type Counts = Record<string, number>;

/**
 * Live vote counts in Redis, and broadcasts coalesced to one per window.
 *
 * Why: with ~3,000 delegates voting in the same few seconds, counting from
 * Postgres and broadcasting on every vote meant a GROUP BY per vote and a
 * fan-out of every result to every phone. Here each vote is one HINCRBY and
 * the room hears the standing at most once per second, whichever API
 * instance took the vote.
 *
 * Postgres stays the source of truth. A hash is seeded from it when missing,
 * and callers overwrite it with the authoritative count (`reset`) whenever a
 * result becomes final - closing a poll, a ballot, a trivia question - so any
 * drift from a cold-start race cannot outlive the live phase.
 */
@Injectable()
export class LiveTallyService {
  private readonly logger = new Logger(LiveTallyService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  static key(namespace: string, id: string): string {
    return `tally:${namespace}:${id}`;
  }

  /**
   * Seeds the hash from Postgres unless it is already seeded. Call it before
   * the vote's own DB write, so the seed cannot include the vote that `apply`
   * is about to add.
   *
   * Two instances seeding at once is settled by HSETNX on the marker: only
   * the one that set it adds the loaded counts.
   */
  async ensure(key: string, load: () => Promise<Counts>): Promise<void> {
    if (await this.redis.hexists(key, SEEDED_FIELD)) return;
    const counts = await load();
    const won = await this.redis.hsetnx(key, SEEDED_FIELD, '1');
    if (!won) return;
    const multi = this.redis.multi();
    for (const [field, n] of Object.entries(counts)) {
      if (n !== 0) multi.hincrby(key, field, n);
    }
    multi.pexpire(key, COUNTS_TTL_MS);
    await multi.exec();
  }

  /** Moves counts by the given amounts in one round trip (+1 new, -1 old). */
  async apply(key: string, deltas: Counts): Promise<void> {
    const entries = Object.entries(deltas).filter(([, n]) => n !== 0);
    if (entries.length === 0) return;
    const multi = this.redis.multi();
    for (const [field, n] of entries) multi.hincrby(key, field, n);
    await multi.exec();
  }

  /** The counts as stored, without the seed marker. */
  async read(key: string): Promise<Counts> {
    const raw = await this.redis.hgetall(key);
    const counts: Counts = {};
    for (const [field, value] of Object.entries(raw)) {
      if (field !== SEEDED_FIELD) counts[field] = Number(value);
    }
    return counts;
  }

  /** `ensure` then `read`: for readers that may meet a cold key. */
  async counts(key: string, load: () => Promise<Counts>): Promise<Counts> {
    await this.ensure(key, load);
    return this.read(key);
  }

  /** Replaces the hash with authoritative counts, in one transaction. */
  async reset(key: string, counts: Counts): Promise<void> {
    const multi = this.redis.multi();
    multi.del(key);
    multi.hset(key, SEEDED_FIELD, '1');
    for (const [field, n] of Object.entries(counts)) {
      if (n !== 0) multi.hset(key, field, String(n));
    }
    multi.pexpire(key, COUNTS_TTL_MS);
    await multi.exec();
  }

  async drop(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  /**
   * Coalesces broadcasts of one item across every instance.
   *
   * Marks `name` dirty with SET NX PX; only the caller that set the flag
   * schedules `emit`, which runs once the window has passed and should read
   * the latest counts itself. So however many votes land in a window, the
   * room hears one broadcast carrying all of them, and never a stale one.
   *
   * Returns whether this caller scheduled the emit. Errors inside `emit` are
   * logged, not thrown: the vote that triggered it has long been answered.
   */
  async coalesce(
    name: string,
    emit: () => Promise<void> | void,
    windowMs = TALLY_EMIT_WINDOW_MS,
  ): Promise<boolean> {
    const won = await this.redis.set(
      `tally:emit:${name}`,
      '1',
      'PX',
      windowMs,
      'NX',
    );
    if (won !== 'OK') return false;

    const timer = setTimeout(() => {
      Promise.resolve()
        .then(emit)
        .catch((error: unknown) =>
          this.logger.warn(
            `coalesced emit ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }, windowMs + EMIT_MARGIN_MS);
    // a pending broadcast must not hold a shutting-down process open
    timer.unref?.();
    return true;
  }

  /** Records that `member` changed, for a batch emit (see `drainDirty`). */
  async markDirty(setKey: string, member: string): Promise<void> {
    await this.redis.sadd(setKey, member);
  }

  /**
   * Takes every member marked since the last drain. SPOP is atomic, so two
   * instances draining the same set never both emit the same member.
   */
  async drainDirty(setKey: string, max = 1000): Promise<string[]> {
    return this.redis.spop(setKey, max);
  }
}
