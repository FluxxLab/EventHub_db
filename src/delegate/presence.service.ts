import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { REDIS } from '../common/redis/redis.module';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';

/** One delegate's online status as clients receive it. */
export interface PresenceView {
  id: string;
  online: boolean;
  /** When they were last connected; null while online, or never seen. */
  lastSeenAt: string | null;
}

/** Set of the delegates with at least one socket on one API instance. */
export const presenceInstanceKey = (instanceId: string) =>
  `pr:inst:${instanceId}`;
/** Sorted set of instance ids, scored by their last presence heartbeat (ms). */
export const PRESENCE_INSTANCES_KEY = 'pr:instances';
/** Hash: delegate id -> epoch ms they were last seen connected. */
export const LAST_SEEN_KEY = 'pr:seen';

/** How often each instance rewrites its set and refreshes its expiry. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** An instance set not refreshed for this long is gone (the instance crashed). */
export const PRESENCE_TTL_MS = 45_000;
/**
 * A delegate whose last socket drops stays online this long before anyone is
 * told, so a reconnect (network switch, app brought back to the foreground)
 * is not an offline/online pair pushed to everyone watching.
 */
export const OFFLINE_GRACE_MS = 5_000;
/** Most delegates one socket may watch at once. */
export const MAX_WATCHED_PER_SOCKET = 500;

/**
 * Who is online, across every API instance.
 *
 * Each instance keeps its own connected delegates in memory (a socket count
 * per delegate) and mirrors the set of them into Redis as `pr:inst:{id}`,
 * rewritten whole every PRESENCE_HEARTBEAT_MS with a PRESENCE_TTL_MS expiry.
 * A delegate is online if any live instance's set holds them. Rewriting the
 * whole set (DEL + SADD in one MULTI) means a missed SREM cannot leave a
 * ghost for longer than one heartbeat, and a crashed instance's set simply
 * expires, taking its delegates offline within ~45 s.
 *
 * Live instances are found from `pr:instances` (score = last heartbeat), so
 * no KEYS/SCAN is ever needed; lookups are one pipelined SMISMEMBER per live
 * instance whatever the number of ids asked about.
 *
 * Changes are pushed as `presence:update` to `presence:{delegateId}`, a room
 * only sockets that asked to watch that delegate (and were allowed to) are
 * in - never broadcast. The first socket of a delegate anywhere is "online";
 * the last one gone, after OFFLINE_GRACE_MS, is "offline".
 *
 * Privacy is enforced where watching is granted (DelegatesService decides who
 * may see whom); this service also pulls watchers out of rooms when a block
 * or a hidden profile withdraws that permission.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly instanceId = randomUUID();
  /** Delegate id -> sockets this instance holds for them. */
  private readonly local = new Map<string, number>();
  /** Delegates whose last local socket dropped, waiting out the grace period. */
  private readonly grace = new Map<string, NodeJS.Timeout>();
  private server: Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly realtime: RealtimeService,
    @Optional() @Inject(REDIS) private readonly redis?: Redis,
  ) {}

  /** Called once by the delegates gateway after init. */
  bindServer(server: Server): void {
    if (this.server === server) return;
    this.server = server;
    if (!this.redis || this.heartbeatTimer) return;
    void this.heartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      PRESENCE_HEARTBEAT_MS,
    );
    this.heartbeatTimer.unref?.();
  }

  /** A signed-in delegate's socket connected to this instance. */
  async connected(delegateId: string): Promise<void> {
    const pending = this.grace.get(delegateId);
    if (pending) {
      // back within the grace period: they never went offline to anyone
      clearTimeout(pending);
      this.grace.delete(delegateId);
    }
    const count = (this.local.get(delegateId) ?? 0) + 1;
    this.local.set(delegateId, count);
    if (count > 1 || pending) return;
    if (!this.redis) {
      this.emitChange(delegateId, true, null);
      return;
    }

    try {
      const elsewhere = await this.onlineElsewhere(delegateId);
      const now = Date.now();
      await this.redis
        .multi()
        .sadd(presenceInstanceKey(this.instanceId), delegateId)
        .pexpire(presenceInstanceKey(this.instanceId), PRESENCE_TTL_MS)
        .zadd(PRESENCE_INSTANCES_KEY, now, this.instanceId)
        .hset(LAST_SEEN_KEY, delegateId, String(now))
        .exec();
      if (!elsewhere) this.emitChange(delegateId, true, null);
    } catch (err) {
      // the next heartbeat rewrites the set; only the live push is lost
      this.logger.warn(`presence connect failed: ${String(err)}`);
    }
  }

  /** One of the delegate's sockets on this instance went away. */
  disconnected(delegateId: string): void {
    const count = (this.local.get(delegateId) ?? 0) - 1;
    if (count > 0) {
      this.local.set(delegateId, count);
      return;
    }
    this.local.delete(delegateId);
    if (this.grace.has(delegateId)) return;
    const timer = setTimeout(
      () => void this.settleOffline(delegateId),
      OFFLINE_GRACE_MS,
    );
    timer.unref?.();
    this.grace.set(delegateId, timer);
  }

  /** The grace period ran out with no socket back on this instance. */
  async settleOffline(delegateId: string): Promise<void> {
    this.grace.delete(delegateId);
    if (this.local.has(delegateId)) return;
    const now = Date.now();
    if (!this.redis) {
      this.emitChange(delegateId, false, new Date(now).toISOString());
      return;
    }
    try {
      await this.redis
        .multi()
        .srem(presenceInstanceKey(this.instanceId), delegateId)
        .hset(LAST_SEEN_KEY, delegateId, String(now))
        .exec();
      // still connected through another instance (a second device): no change
      if (await this.onlineElsewhere(delegateId)) return;
      this.emitChange(delegateId, false, new Date(now).toISOString());
    } catch (err) {
      this.logger.warn(`presence disconnect failed: ${String(err)}`);
    }
  }

  /**
   * Current status of each id, in the order asked. The caller has already
   * filtered `ids` to the ones the viewer may see.
   */
  async lookup(ids: string[]): Promise<PresenceView[]> {
    if (ids.length === 0) return [];
    const onlineHere = (id: string) => this.local.has(id) || this.grace.has(id);
    if (!this.redis) {
      return ids.map((id) => ({
        id,
        online: onlineHere(id),
        lastSeenAt: null,
      }));
    }
    try {
      const instances = await this.liveInstances();
      const pipeline = this.redis.pipeline();
      for (const instance of instances) {
        pipeline.smismember(presenceInstanceKey(instance), ids);
      }
      pipeline.hmget(LAST_SEEN_KEY, ...ids);
      const results = (await pipeline.exec()) ?? [];
      const memberships = results
        .slice(0, instances.length)
        .map(([, value]) => (value as number[] | null) ?? []);
      const seen = (results[instances.length]?.[1] ?? []) as (string | null)[];
      return ids.map((id, i) => {
        const online =
          onlineHere(id) || memberships.some((row) => row[i] === 1);
        const ms = Number(seen[i]);
        return {
          id,
          online,
          lastSeenAt:
            online || !seen[i] || !Number.isFinite(ms)
              ? null
              : new Date(ms).toISOString(),
        };
      });
    } catch (err) {
      this.logger.warn(`presence lookup fell back to local: ${String(err)}`);
      return ids.map((id) => ({
        id,
        online: onlineHere(id),
        lastSeenAt: null,
      }));
    }
  }

  /** How many distinct delegates are online right now, across all instances. */
  async onlineCount(): Promise<number> {
    const localCount = this.local.size + this.grace.size;
    if (!this.redis) return localCount;
    try {
      const keys = (await this.liveInstances()).map(presenceInstanceKey);
      if (keys.length === 0) return localCount;
      if (keys.length === 1) return await this.redis.scard(keys[0]);
      // one delegate on two devices on two instances is one person
      const tmp = `pr:count:${this.instanceId}`;
      const count = await this.redis.sunionstore(tmp, ...keys);
      await this.redis.del(tmp);
      return count;
    } catch (err) {
      this.logger.warn(`presence count fell back to local: ${String(err)}`);
      return localCount;
    }
  }

  /**
   * Adds the socket to each delegate's presence room, up to the per-socket
   * cap. `ids` must already be the ones this viewer is allowed to watch.
   */
  watch(socket: Socket, ids: string[]): string[] {
    let watching = 0;
    for (const room of socket.rooms) {
      if (room.startsWith('presence:') && !room.startsWith('presence:self:')) {
        watching += 1;
      }
    }
    const joined: string[] = [];
    for (const id of ids) {
      const room = Rooms.presence(id);
      if (!socket.rooms.has(room)) {
        if (watching >= MAX_WATCHED_PER_SOCKET) continue;
        watching += 1;
      }
      void socket.join(room);
      joined.push(id);
    }
    return joined;
  }

  unwatch(socket: Socket, ids: string[]): void {
    for (const id of ids) void socket.leave(Rooms.presence(id));
  }

  /** A block either way: neither delegate keeps watching the other. */
  revokeBetween(a: string, b: string): void {
    if (!this.server) return;
    this.server.in(Rooms.presenceSelf(a)).socketsLeave(Rooms.presence(b));
    this.server.in(Rooms.presenceSelf(b)).socketsLeave(Rooms.presence(a));
  }

  /** The delegate hid themselves from the directory: nobody watches them now. */
  revokeAll(delegateId: string): void {
    if (!this.server) return;
    const room = Rooms.presence(delegateId);
    this.server.in(room).socketsLeave(room);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const timer of this.grace.values()) clearTimeout(timer);
    this.grace.clear();
    if (!this.redis) return;
    try {
      // a clean shutdown leaves at once rather than when the set expires;
      // the clients reconnect to another instance and show up from there
      await this.redis
        .multi()
        .del(presenceInstanceKey(this.instanceId))
        .zrem(PRESENCE_INSTANCES_KEY, this.instanceId)
        .exec();
    } catch {
      // Redis may already be gone at shutdown; the TTL covers it
    }
  }

  private emitChange(
    delegateId: string,
    online: boolean,
    lastSeenAt: string | null,
  ): void {
    const payload: PresenceView = { id: delegateId, online, lastSeenAt };
    this.realtime.emitToRoom(
      Rooms.presence(delegateId),
      'presence:update',
      payload,
    );
  }

  /** Instances that have heartbeated within the TTL. */
  private async liveInstances(): Promise<string[]> {
    return this.redis!.zrangebyscore(
      PRESENCE_INSTANCES_KEY,
      Date.now() - PRESENCE_TTL_MS,
      '+inf',
    );
  }

  /** Whether another live instance holds a socket for this delegate. */
  private async onlineElsewhere(delegateId: string): Promise<boolean> {
    const others = (await this.liveInstances()).filter(
      (id) => id !== this.instanceId,
    );
    if (others.length === 0) return false;
    const pipeline = this.redis!.pipeline();
    for (const instance of others) {
      pipeline.sismember(presenceInstanceKey(instance), delegateId);
    }
    const results = (await pipeline.exec()) ?? [];
    return results.some(([, value]) => value === 1);
  }

  /**
   * Rewrites this instance's set from memory and refreshes its expiry and
   * the last-seen time of everyone on it, so a crash leaves last-seen at
   * most one heartbeat stale.
   */
  async heartbeat(): Promise<void> {
    if (!this.redis) return;
    const ids = [...this.local.keys(), ...this.grace.keys()];
    const now = Date.now();
    const key = presenceInstanceKey(this.instanceId);
    const tx = this.redis.multi().del(key);
    if (ids.length > 0) {
      tx.sadd(key, ...ids)
        .pexpire(key, PRESENCE_TTL_MS)
        .hset(
          LAST_SEEN_KEY,
          Object.fromEntries(ids.map((id) => [id, String(now)])),
        );
    }
    tx.zadd(PRESENCE_INSTANCES_KEY, now, this.instanceId).zremrangebyscore(
      PRESENCE_INSTANCES_KEY,
      '-inf',
      now - PRESENCE_TTL_MS * 2,
    );
    try {
      await tx.exec();
    } catch (err) {
      this.logger.warn(`presence heartbeat failed: ${String(err)}`);
    }
  }
}
