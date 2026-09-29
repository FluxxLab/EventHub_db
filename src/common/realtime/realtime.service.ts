import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { REDIS } from '../redis/redis.module';

export const Rooms = {
  session: (id: string) => `session:${id}`,
  /**
   * English keeps the original room name, so mobile and admin clients that
   * joined before translation existed keep working unchanged.
   */
  caption: (sessionId: string, language: string = 'en') =>
    language === 'en'
      ? `captions:${sessionId}`
      : `captions:${sessionId}:${language}`,
  discussion: (sessionId: string) => `discussion:${sessionId}`,
  /** Questions from the floor for one session (post-summit report, XV.1). */
  questions: (sessionId: string) => `questions:${sessionId}`,
  /** Polls fired from the stage; one room for the whole summit, like trivia. */
  polls: 'polls',
  /**
   * `voting` and `trivia` are the original summit-wide rooms, kept for
   * clients that join without naming an event (the console). The app joins
   * one event's room instead, so a phone at one event does not hear another's.
   */
  voting: 'voting',
  trivia: 'trivia',
  votingEdition: (editionId: string) => `voting:${editionId}`,
  triviaEdition: (editionId: string) => `trivia:${editionId}`,
  notifications: (segment: string) => `notifications:${segment}`,
  dm: (pairKey: string) => `dm:${pairKey}`,
  network: (delegateId: string) => `network:${delegateId}`,
  /** Everyone watching one delegate's online status (see PresenceService). */
  presence: (delegateId: string) => `presence:${delegateId}`,
  /** One delegate's own sockets, so a block can pull them out of presence rooms. */
  presenceSelf: (delegateId: string) => `presence:self:${delegateId}`,
} as const;

/**
 * Rooms nobody counts viewers of. Presence rooms are many and small (one per
 * delegate someone is looking at), so publishing their sizes to Redis on
 * every join and heartbeat would be pure write load.
 */
const isCounted = (room: string) => !room.startsWith('presence:');

/** Hash per room: field = instance id, value = that instance's local size. */
export const roomSizeKey = (room: string) => `rt:room:${room}`;
/** Liveness key per instance; a field whose instance key is gone is ignored. */
export const instanceKey = (instanceId: string) => `rt:instance:${instanceId}`;

/** How often an instance refreshes its liveness key, and how long it lasts. */
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_TTL_SECONDS = 30;
/** Joins and leaves within this window go to Redis as one write per room. */
export const FLUSH_MS = 200;

/**
 * Viewer counts across every API instance, without `fetchSockets()`.
 *
 * `fetchSockets()` asks every instance over the Redis adapter to list its
 * sockets and waits for all of them; the live-ops dashboard does that per
 * session per refresh, which at 3,000 delegates on 2+ instances is a
 * cluster-wide broadcast on every poll.
 *
 * Instead each instance publishes its own exact local room size into one
 * Redis hash per room (`rt:room:{room}`, field = this instance's id), kept
 * up to date from the socket.io adapter's `join-room` / `leave-room` events.
 * The value written is the adapter's local count at that moment (HSET, not
 * HINCRBY), so a missed or duplicated event cannot accumulate drift: the
 * next event for that room writes the true number again. Writes are
 * coalesced per room for FLUSH_MS, so a thousand joins at session start are
 * a handful of pipelined HSETs, not a thousand round trips.
 *
 * Crash drift: an instance that dies without cleaning up leaves its fields
 * behind. Each instance refreshes `rt:instance:{id}` every HEARTBEAT_MS with
 * a HEARTBEAT_TTL_SECONDS expiry; `roomSize` only sums fields whose instance
 * key is still alive and removes the dead ones as it finds them. So a crashed
 * instance's viewers disappear from the count within ~30 s, which is also
 * about how long its clients take to reconnect elsewhere. A restarted process
 * gets a fresh id and never inherits stale fields.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  private readonly instanceId = randomUUID();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(@Optional() @Inject(REDIS) private readonly redis?: Redis) {}

  /**
   * Called once by the gateway in afterinit
   */
  bindServer(server: Server): void {
    if (this.server === server) return;
    this.server = server;
    if (!this.redis) return;

    const adapter = server.of('/').adapter;
    // every socket sits in a room named after its own id; those are not
    // audiences anyone counts, so they are not published
    const track = (room: string, id: string) => {
      if (room !== id && isCounted(room)) this.markDirty(room);
    };
    adapter.on('join-room', track);
    adapter.on('leave-room', track);

    void this.heartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      HEARTBEAT_MS,
    );
    this.heartbeatTimer.unref?.();
  }

  // Accepts several rooms so one emit can reach both an open thread and the
  // recipient's personal room; socket.io delivers once to a socket in both.
  emitToRoom(room: string | string[], event: string, payload: unknown): void {
    if (!this.server) {
      const target = Array.isArray(room) ? room.join(', ') : room;
      this.logger.warn(`emit before gateway init: ${event} -> ${target}`);
      return;
    }

    /**
     * Redis adapter propagates this to every API instance ()
     */
    this.server.to(room).emit(event, payload);
  }

  /**
   * Broadcast to every connected client, all instances(cut-to-break, overlay toggles)
   */
  emitGlobal(event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(`emit before gateware init: ${event} (global)`);
      return;
    }
    this.server.emit(event, payload);
  }

  /**
   * How many sockets are in a room, across all instances (viewer counts).
   * Two Redis round trips whatever the number of instances; falls back to
   * this instance's own count if Redis cannot be reached.
   */
  async roomSize(room: string): Promise<number> {
    if (!this.server) return 0;
    if (!this.redis) return this.localSize(room);

    try {
      const perInstance = await this.redis.hgetall(roomSizeKey(room));
      const ids = Object.keys(perInstance);
      if (ids.length === 0) return 0;
      const alive = await this.redis.mget(ids.map(instanceKey));
      let total = 0;
      const dead: string[] = [];
      ids.forEach((id, i) => {
        if (id === this.instanceId || alive[i] !== null) {
          total += Number(perInstance[id]) || 0;
        } else {
          dead.push(id);
        }
      });
      if (dead.length > 0) {
        void this.redis.hdel(roomSizeKey(room), ...dead).catch(() => undefined);
      }
      return total;
    } catch (err) {
      this.logger.warn(`roomSize(${room}) fell back to local: ${String(err)}`);
      return this.localSize(room);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.heartbeatTimer = null;
    this.flushTimer = null;
    if (!this.redis) return;
    // a clean shutdown drops out of every count at once rather than after
    // the heartbeat expires
    try {
      await this.redis.del(instanceKey(this.instanceId));
    } catch {
      // Redis may already be gone at shutdown; the TTL covers it
    }
  }

  /** This instance's exact count, straight from the adapter. */
  private localSize(room: string): number {
    return this.server?.of('/').adapter.rooms.get(room)?.size ?? 0;
  }

  private markDirty(room: string): void {
    this.dirty.add(room);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Publish this instance's current size for every room touched since the last flush. */
  async flush(): Promise<void> {
    this.flushTimer = null;
    if (!this.redis || this.dirty.size === 0) return;
    const rooms = [...this.dirty];
    this.dirty.clear();
    const pipeline = this.redis.pipeline();
    for (const room of rooms) {
      const size = this.localSize(room);
      if (size > 0) pipeline.hset(roomSizeKey(room), this.instanceId, size);
      else pipeline.hdel(roomSizeKey(room), this.instanceId);
    }
    try {
      await pipeline.exec();
    } catch (err) {
      // retried on the next heartbeat, which republishes every room
      this.logger.warn(`room size flush failed: ${String(err)}`);
    }
  }

  /**
   * Refresh this instance's liveness, and republish every room it holds so a
   * field pruned during a Redis blip (or a failed flush) comes back within
   * one heartbeat.
   */
  private async heartbeat(): Promise<void> {
    const adapter = this.server?.of('/').adapter;
    if (adapter) {
      for (const room of adapter.rooms.keys()) {
        if (!adapter.sids.has(room) && isCounted(room)) this.dirty.add(room);
      }
      if (this.dirty.size > 0) void this.flush();
    }
    try {
      await this.redis!.set(
        instanceKey(this.instanceId),
        '1',
        'EX',
        HEARTBEAT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`realtime heartbeat failed: ${String(err)}`);
    }
  }
}
