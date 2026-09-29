import { EventEmitter } from 'events';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import {
  RealtimeService,
  Rooms,
  instanceKey,
  roomSizeKey,
} from './realtime.service';

/**
 * Viewer counts come from one Redis hash per room that every instance writes
 * its own exact local count into, never from fetchSockets() across the
 * cluster. A crashed instance's stale field is ignored once its heartbeat
 * key has expired.
 */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const hset = (key: string, field: string, value: number) => {
    const h = hashes.get(key) ?? new Map<string, string>();
    h.set(field, String(value));
    hashes.set(key, h);
  };
  const hdel = (key: string, ...fields: string[]) => {
    for (const f of fields) hashes.get(key)?.delete(f);
    return Promise.resolve(fields.length);
  };
  const redis = {
    hashes,
    strings,
    hset,
    set: jest.fn((key: string, value: string) => {
      strings.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      strings.delete(key);
      return Promise.resolve(1);
    }),
    mget: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map((k) => strings.get(k) ?? null)),
    ),
    hgetall: jest.fn((key: string) =>
      Promise.resolve(Object.fromEntries(hashes.get(key) ?? new Map())),
    ),
    hdel: jest.fn(hdel),
    pipeline: jest.fn(() => {
      const ops: (() => void)[] = [];
      const p = {
        hset: (key: string, field: string, value: number) => {
          ops.push(() => hset(key, field, value));
          return p;
        },
        hdel: (key: string, field: string) => {
          ops.push(() => void hdel(key, field));
          return p;
        },
        exec: () => {
          ops.forEach((op) => op());
          return Promise.resolve([]);
        },
      };
      return p;
    }),
  };
  return redis;
}

/** The in-memory adapter's bookkeeping and events, as socket.io does it. */
class FakeAdapter extends EventEmitter {
  rooms = new Map<string, Set<string>>();
  sids = new Map<string, Set<string>>();

  join(room: string, id: string): void {
    if (!this.sids.has(id)) {
      this.sids.set(id, new Set([id]));
      this.rooms.set(id, new Set([id]));
      this.emit('join-room', id, id);
    }
    const r = this.rooms.get(room) ?? new Set<string>();
    this.rooms.set(room, r);
    r.add(id);
    this.emit('join-room', room, id);
  }

  leave(room: string, id: string): void {
    this.rooms.get(room)?.delete(id);
    this.emit('leave-room', room, id);
    if (this.rooms.get(room)?.size === 0) this.rooms.delete(room);
  }
}

/** A socket.io server whose default namespace has an in-memory adapter. */
function fakeServer() {
  const adapter = new FakeAdapter();
  const fetchSockets = jest.fn();
  const server = {
    of: () => ({ adapter }),
    in: () => ({ fetchSockets }),
    to: jest.fn(() => ({ emit: jest.fn() })),
    emit: jest.fn(),
  };
  return { server: server as unknown as Server, adapter, fetchSockets };
}

describe('RealtimeService.roomSize', () => {
  const room = Rooms.session('s1');
  let services: RealtimeService[] = [];
  afterEach(async () => {
    await Promise.all(services.map((s) => s.onModuleDestroy()));
    services = [];
  });

  function instance(redis: ReturnType<typeof fakeRedis>) {
    const service = new RealtimeService(redis as unknown as Redis);
    services.push(service);
    const io = fakeServer();
    service.bindServer(io.server);
    return { service, ...io };
  }

  it('publishes the local count from join/leave events, coalesced, never via fetchSockets', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    a.adapter.join(room, 'x1');
    a.adapter.join(room, 'x2');
    a.adapter.join(room, 'x3');
    a.adapter.leave(room, 'x2');
    await a.service.flush();
    expect(await a.service.roomSize(room)).toBe(2);
    expect(a.fetchSockets).not.toHaveBeenCalled();
    // socket-id rooms are never published
    expect(redis.hashes.has(roomSizeKey('x1'))).toBe(false);
  });

  it('sums every live instance', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    const b = instance(redis);
    a.adapter.join(room, 'x1');
    b.adapter.join(room, 'y1');
    b.adapter.join(room, 'y2');
    await a.service.flush();
    await b.service.flush();
    expect(await a.service.roomSize(room)).toBe(3);
    expect(await b.service.roomSize(room)).toBe(3);
  });

  it('drops a crashed instance once its heartbeat key has expired', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    a.adapter.join(room, 'x1');
    await a.service.flush();
    // an instance that died holding 40 viewers, heartbeat long expired
    redis.hset(roomSizeKey(room), 'dead-instance', 40);
    expect(redis.strings.has(instanceKey('dead-instance'))).toBe(false);
    expect(await a.service.roomSize(room)).toBe(1);
    // and its field is pruned
    expect(redis.hdel).toHaveBeenCalledWith(roomSizeKey(room), 'dead-instance');
  });

  it('removes its field when the room empties locally', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    a.adapter.join(room, 'x1');
    await a.service.flush();
    a.adapter.leave(room, 'x1');
    await a.service.flush();
    expect(await a.service.roomSize(room)).toBe(0);
    expect(redis.hashes.get(roomSizeKey(room))?.size ?? 0).toBe(0);
  });

  it('falls back to the local count when Redis is unreachable', async () => {
    const redis = fakeRedis();
    const a = instance(redis);
    a.adapter.join(room, 'x1');
    redis.hgetall.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await a.service.roomSize(room)).toBe(1);
  });

  it('is zero before the gateway binds', async () => {
    const service = new RealtimeService(fakeRedis() as unknown as Redis);
    services.push(service);
    expect(await service.roomSize(room)).toBe(0);
  });
});
