import type Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import type { RealtimeService } from '../common/realtime/realtime.service';
import {
  LAST_SEEN_KEY,
  MAX_WATCHED_PER_SOCKET,
  OFFLINE_GRACE_MS,
  PRESENCE_INSTANCES_KEY,
  PRESENCE_TTL_MS,
  PresenceService,
  presenceInstanceKey,
} from './presence.service';

/**
 * Just the Redis commands presence uses, over in-memory sets, one sorted set
 * and hashes. `multi()` and `pipeline()` queue and run in order, answering
 * [err, result] pairs like ioredis.
 */
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const set = (key: string) => {
    const s = sets.get(key) ?? new Set<string>();
    sets.set(key, s);
    return s;
  };
  const zset = (key: string) => {
    const z = zsets.get(key) ?? new Map<string, number>();
    zsets.set(key, z);
    return z;
  };
  const hash = (key: string) => {
    const h = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, h);
    return h;
  };
  const num = (v: string | number) =>
    v === '+inf' ? Infinity : v === '-inf' ? -Infinity : Number(v);

  const commands = {
    sadd: (key: string, ...members: string[]) => {
      members.forEach((m) => set(key).add(m));
      return members.length;
    },
    srem: (key: string, ...members: string[]) => {
      members.forEach((m) => sets.get(key)?.delete(m));
      return members.length;
    },
    sismember: (key: string, m: string) => (sets.get(key)?.has(m) ? 1 : 0),
    smismember: (key: string, members: string[]) =>
      members.map((m) => (sets.get(key)?.has(m) ? 1 : 0)),
    scard: (key: string) => sets.get(key)?.size ?? 0,
    sunionstore: (dest: string, ...keys: string[]) => {
      const union = new Set<string>();
      keys.forEach((k) => sets.get(k)?.forEach((m) => union.add(m)));
      sets.set(dest, union);
      return union.size;
    },
    pexpire: () => 1,
    del: (key: string) => {
      sets.delete(key);
      return 1;
    },
    zadd: (key: string, score: number, member: string) => {
      zset(key).set(member, score);
      return 1;
    },
    zrem: (key: string, member: string) => (zset(key).delete(member) ? 1 : 0),
    zrangebyscore: (key: string, min: number | string, max: number | string) =>
      [...zset(key).entries()]
        .filter(([, s]) => s >= num(min) && s <= num(max))
        .map(([m]) => m),
    zremrangebyscore: (
      key: string,
      min: number | string,
      max: number | string,
    ) => {
      let n = 0;
      for (const [m, s] of zset(key)) {
        if (s >= num(min) && s <= num(max)) {
          zset(key).delete(m);
          n += 1;
        }
      }
      return n;
    },
    hset: (key: string, ...args: unknown[]) => {
      const entries =
        typeof args[0] === 'object'
          ? Object.entries(args[0] as Record<string, string>)
          : [[args[0] as string, args[1] as string]];
      entries.forEach(([f, v]) => hash(key).set(f, v));
      return entries.length;
    },
    hmget: (key: string, ...fields: string[]) =>
      fields.map((f) => hashes.get(key)?.get(f) ?? null),
  };
  type Name = keyof typeof commands;

  const chain = () => {
    const ops: (() => unknown)[] = [];
    const c: Record<string, unknown> = {
      exec: () => Promise.resolve(ops.map((op) => [null, op()])),
    };
    for (const name of Object.keys(commands) as Name[]) {
      c[name] = (...args: unknown[]) => {
        ops.push(() =>
          (commands[name] as (...a: unknown[]) => unknown)(...args),
        );
        return c;
      };
    }
    return c;
  };

  const redis: Record<string, unknown> = {
    sets,
    zsets,
    hashes,
    multi: jest.fn(chain),
    pipeline: jest.fn(chain),
  };
  for (const name of Object.keys(commands) as Name[]) {
    redis[name] = jest.fn((...args: unknown[]) =>
      Promise.resolve(
        (commands[name] as (...a: unknown[]) => unknown)(...args),
      ),
    );
  }
  return redis as typeof redis & {
    sets: typeof sets;
    zsets: typeof zsets;
    hashes: typeof hashes;
  };
}

function instance(redis: ReturnType<typeof fakeRedis>) {
  const realtime = { emitToRoom: jest.fn() };
  const service = new PresenceService(
    realtime as unknown as RealtimeService,
    redis as unknown as Redis,
  );
  const id = (service as unknown as { instanceId: string }).instanceId;
  return { service, realtime, id };
}

const updates = (realtime: { emitToRoom: jest.Mock }) =>
  realtime.emitToRoom.mock.calls.map(
    ([room, event, payload]: [string, string, unknown]) => ({
      room,
      event,
      payload,
    }),
  );

const ADA = '11111111-1111-4111-8111-111111111111';
const TUNDE = '22222222-2222-4222-8222-222222222222';

describe('PresenceService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2027-09-07T09:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('goes online on the first socket, pushing only to the watchers room', async () => {
    const redis = fakeRedis();
    const { service, realtime, id } = instance(redis);

    await service.connected(ADA);
    await service.connected(ADA); // a second tab: no second push

    expect(redis.sets.get(presenceInstanceKey(id))).toEqual(new Set([ADA]));
    expect(redis.zsets.get(PRESENCE_INSTANCES_KEY)?.has(id)).toBe(true);
    expect(updates(realtime)).toEqual([
      {
        room: `presence:${ADA}`,
        event: 'presence:update',
        payload: { id: ADA, online: true, lastSeenAt: null },
      },
    ]);
    await expect(service.lookup([ADA, TUNDE])).resolves.toEqual([
      { id: ADA, online: true, lastSeenAt: null },
      { id: TUNDE, online: false, lastSeenAt: null },
    ]);
  });

  it('goes offline only after the last socket and the grace period, with lastSeenAt', async () => {
    const redis = fakeRedis();
    const { service, realtime, id } = instance(redis);
    await service.connected(ADA);
    await service.connected(ADA);
    realtime.emitToRoom.mockClear();

    service.disconnected(ADA);
    service.disconnected(ADA);
    // still inside the grace period: nothing pushed, still online
    await jest.advanceTimersByTimeAsync(OFFLINE_GRACE_MS - 1);
    expect(realtime.emitToRoom).not.toHaveBeenCalled();
    expect((await service.lookup([ADA]))[0].online).toBe(true);

    await jest.advanceTimersByTimeAsync(1);
    const at = new Date(Date.now()).toISOString();
    expect(updates(realtime)).toEqual([
      {
        room: `presence:${ADA}`,
        event: 'presence:update',
        payload: { id: ADA, online: false, lastSeenAt: at },
      },
    ]);
    expect(redis.sets.get(presenceInstanceKey(id))?.has(ADA)).toBe(false);
    await expect(service.lookup([ADA])).resolves.toEqual([
      { id: ADA, online: false, lastSeenAt: at },
    ]);
  });

  it('coalesces a quick reconnect into no change at all', async () => {
    const redis = fakeRedis();
    const { service, realtime } = instance(redis);
    await service.connected(ADA);
    realtime.emitToRoom.mockClear();

    service.disconnected(ADA);
    await jest.advanceTimersByTimeAsync(1_000);
    await service.connected(ADA);
    await jest.advanceTimersByTimeAsync(OFFLINE_GRACE_MS * 2);

    expect(realtime.emitToRoom).not.toHaveBeenCalled();
    expect((await service.lookup([ADA]))[0].online).toBe(true);
  });

  it('stays online while another instance still holds a socket', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    const b = instance(redis);

    await a.service.connected(ADA);
    await b.service.connected(ADA); // second device, other instance
    // only the first connection anywhere is news
    expect(a.realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect(b.realtime.emitToRoom).not.toHaveBeenCalled();

    a.service.disconnected(ADA);
    await jest.advanceTimersByTimeAsync(OFFLINE_GRACE_MS);
    expect(a.realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect((await a.service.lookup([ADA]))[0].online).toBe(true);

    b.service.disconnected(ADA);
    await jest.advanceTimersByTimeAsync(OFFLINE_GRACE_MS);
    expect(b.realtime.emitToRoom).toHaveBeenLastCalledWith(
      `presence:${ADA}`,
      'presence:update',
      expect.objectContaining({ id: ADA, online: false }),
    );
    expect((await a.service.lookup([ADA]))[0].online).toBe(false);
  });

  it('forgets a crashed instance once its heartbeat is older than the TTL', async () => {
    const redis = fakeRedis();
    const crashed = instance(redis);
    const alive = instance(redis);
    await crashed.service.connected(TUNDE);
    expect((await alive.service.lookup([TUNDE]))[0].online).toBe(true);

    // the crashed instance never heartbeats again; the live one does
    await jest.advanceTimersByTimeAsync(PRESENCE_TTL_MS + 1);
    await alive.service.heartbeat();

    expect((await alive.service.lookup([TUNDE]))[0]).toMatchObject({
      online: false,
      // last seen when it connected, the last thing the crashed one wrote
      lastSeenAt: '2027-09-07T09:00:00.000Z',
    });
    await expect(alive.service.onlineCount()).resolves.toBe(0);
  });

  it('heartbeat rewrites the set from memory, so a lost SREM cannot leave a ghost', async () => {
    const redis = fakeRedis();
    const { service, id } = instance(redis);
    await service.connected(ADA);
    redis.sets.get(presenceInstanceKey(id))!.add(TUNDE); // stale member

    await service.heartbeat();

    expect(redis.sets.get(presenceInstanceKey(id))).toEqual(new Set([ADA]));
    expect(redis.hashes.get(LAST_SEEN_KEY)?.get(ADA)).toBe(String(Date.now()));
  });

  it('counts distinct delegates across instances for the dashboard', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    const b = instance(redis);
    await a.service.connected(ADA);
    await b.service.connected(ADA);
    await b.service.connected(TUNDE);

    await expect(a.service.onlineCount()).resolves.toBe(2);
    // the temporary union key is not left behind
    expect([...redis.sets.keys()].some((k) => k.startsWith('pr:count:'))).toBe(
      false,
    );
  });

  it('works on one instance without Redis', async () => {
    const realtime = { emitToRoom: jest.fn() };
    const service = new PresenceService(realtime as unknown as RealtimeService);
    await service.connected(ADA);
    await expect(service.onlineCount()).resolves.toBe(1);
    await expect(service.lookup([ADA, TUNDE])).resolves.toEqual([
      { id: ADA, online: true, lastSeenAt: null },
      { id: TUNDE, online: false, lastSeenAt: null },
    ]);
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      `presence:${ADA}`,
      'presence:update',
      { id: ADA, online: true, lastSeenAt: null },
    );
  });
});

describe('PresenceService watching', () => {
  function socket(rooms: string[] = []) {
    const joined = new Set(['sid', ...rooms]);
    return {
      rooms: joined,
      join: jest.fn((room: string) => joined.add(room)),
      leave: jest.fn((room: string) => joined.delete(room)),
    };
  }

  it('joins one presence room per id and leaves on unwatch', () => {
    const { service } = instance(fakeRedis());
    const s = socket();
    expect(service.watch(s as unknown as Socket, [ADA, TUNDE])).toEqual([
      ADA,
      TUNDE,
    ]);
    expect(s.rooms.has(`presence:${ADA}`)).toBe(true);
    service.unwatch(s as unknown as Socket, [ADA]);
    expect(s.rooms.has(`presence:${ADA}`)).toBe(false);
    expect(s.rooms.has(`presence:${TUNDE}`)).toBe(true);
  });

  it('caps how many delegates one socket watches', () => {
    const { service } = instance(fakeRedis());
    const full = Array.from(
      { length: MAX_WATCHED_PER_SOCKET },
      (_, i) => `presence:${i}`,
    );
    // its own self room does not count against the cap
    const s = socket([...full, `presence:self:${ADA}`]);
    expect(service.watch(s as unknown as Socket, [TUNDE])).toEqual([]);
    // re-watching one already joined is fine
    expect(service.watch(s as unknown as Socket, ['0'])).toEqual(['0']);
  });

  it('a block pulls each side out of the other’s room; hiding empties your room', () => {
    const { service } = instance(fakeRedis());
    const calls: { target: string; leave: string }[] = [];
    const server = {
      of: jest.fn(),
      in: jest.fn((target: string) => ({
        socketsLeave: (leave: string) => calls.push({ target, leave }),
      })),
    };
    service.bindServer(server as unknown as Server);

    service.revokeBetween(ADA, TUNDE);
    service.revokeAll(ADA);

    expect(calls).toEqual([
      { target: `presence:self:${ADA}`, leave: `presence:${TUNDE}` },
      { target: `presence:self:${TUNDE}`, leave: `presence:${ADA}` },
      { target: `presence:${ADA}`, leave: `presence:${ADA}` },
    ]);
    void service.onModuleDestroy();
  });
});
