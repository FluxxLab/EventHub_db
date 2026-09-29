import { EventEmitter } from 'events';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService } from './delegates.service';
import { PresenceQueryDto, PRESENCE_BATCH_MAX } from './dto/presence-query.dto';
import type { Delegate } from './entities/delegate.entity';
import { PresenceGateway } from './presence.gateway';
import type { PresenceService, PresenceView } from './presence.service';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADA = '11111111-1111-4111-8111-111111111111';
const TUNDE = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';

function build() {
  const delegateRepository = {
    query: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const messages = { query: jest.fn() };
  const blocks = { createQueryBuilder: jest.fn() };
  const connections = { createQueryBuilder: jest.fn() };
  const presence = {
    lookup: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids.map((id) => ({ id, online: true, lastSeenAt: null })),
      ),
    ),
    revokeBetween: jest.fn(),
    revokeAll: jest.fn(),
  };
  const storage = { resolveAvatar: jest.fn().mockResolvedValue(null) };
  const unused = {};
  const service = new DelegatesService(
    delegateRepository as unknown as Repository<Delegate>,
    unused as Repository<never>,
    connections as unknown as Repository<never>,
    messages as unknown as Repository<never>,
    unused as Repository<never>,
    blocks as unknown as Repository<never>,
    unused as RealtimeService,
    storage as unknown as StorageService,
    unused as Queue,
    unused as DataSource,
    unused as CatalogService,
    undefined,
    presence as unknown as PresenceService,
  );
  return {
    service,
    delegateRepository,
    messages,
    blocks,
    connections,
    presence,
  };
}

describe('who may see whose presence', () => {
  it('asks Postgres once, for directory-visible, unflagged, unblocked delegates (or yourself)', async () => {
    const { service, delegateRepository } = build();
    delegateRepository.query.mockResolvedValue([{ id: ADA }]);

    await expect(
      service.presenceVisibleIds(ME, [ADA, 'not-a-uuid', ADA, TUNDE]),
    ).resolves.toEqual([ADA]);

    expect(delegateRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = delegateRepository.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('d."directoryVisible" = true');
    expect(sql).toContain('d.flagged = false');
    // a block in either direction hides presence both ways
    expect(sql).toContain('b."blockerId" = $1 AND b."blockedId" = d.id');
    expect(sql).toContain('b."blockerId" = d.id AND b."blockedId" = $1');
    expect(sql).toContain('d.id = $1 OR');
    // junk never reaches the ::uuid[] cast, and duplicates are dropped
    expect(params).toEqual([ME, [ADA, TUNDE]]);
  });

  it('does not touch the database for an empty or all-junk batch', async () => {
    const { service, delegateRepository } = build();
    await expect(service.presenceVisibleIds(ME, ['x'])).resolves.toEqual([]);
    expect(delegateRepository.query).not.toHaveBeenCalled();
  });

  it('answers someone you may not see exactly like someone offline', async () => {
    const { service, delegateRepository, presence } = build();
    delegateRepository.query.mockResolvedValue([{ id: ADA }]);

    await expect(service.presenceFor(ME, [HIDDEN, ADA])).resolves.toEqual([
      { id: HIDDEN, online: false, lastSeenAt: null },
      { id: ADA, online: true, lastSeenAt: null },
    ]);
    // Redis is never asked about the hidden one
    expect(presence.lookup).toHaveBeenCalledWith([ADA]);
  });

  it('marks conversations online under the same rules', async () => {
    const { service, delegateRepository, messages } = build();
    messages.query
      .mockResolvedValueOnce([
        {
          pairKey: `${ADA}:${ME}`,
          senderId: ADA,
          recipientId: ME,
          body: 'hi',
          createdAt: new Date('2027-09-07T10:00:00Z'),
        },
        {
          pairKey: `${HIDDEN}:${ME}`,
          senderId: ME,
          recipientId: HIDDEN,
          body: 'hello?',
          createdAt: new Date('2027-09-07T09:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    delegateRepository.find.mockResolvedValue([
      { id: ADA, name: 'Ada', avatarUrl: null },
      { id: HIDDEN, name: 'Hidden', avatarUrl: null },
    ]);
    delegateRepository.query.mockResolvedValue([{ id: ADA }]);

    const list = await service.listConversations(ME);
    expect(list.map((c) => [c.delegate.id, c.online])).toEqual([
      [ADA, true],
      [HIDDEN, false],
    ]);
  });

  it('a block withdraws presence watching both ways', async () => {
    const { service, blocks, connections, presence } = build();
    const qb = {
      insert: () => qb,
      delete: () => qb,
      values: () => qb,
      orIgnore: () => qb,
      where: () => qb,
      execute: jest.fn().mockResolvedValue({}),
    };
    blocks.createQueryBuilder.mockReturnValue(qb);
    connections.createQueryBuilder.mockReturnValue(qb);
    jest.spyOn(service, 'findById').mockResolvedValue({ id: ADA } as Delegate);

    await service.blockDelegate(ME, ADA);
    expect(presence.revokeBetween).toHaveBeenCalledWith(ME, ADA);
  });
});

describe('GET /delegates/presence query', () => {
  const check = async (query: Record<string, unknown>) => {
    const dto = plainToInstance(PresenceQueryDto, query);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return { ids: dto.ids, errors: errors.map((e) => e.property) };
  };

  it('takes comma-separated or repeated ids, deduplicated', async () => {
    await expect(check({ ids: `${ADA}, ${TUNDE},${ADA}` })).resolves.toEqual({
      ids: [ADA, TUNDE],
      errors: [],
    });
    await expect(check({ ids: [ADA, TUNDE] })).resolves.toEqual({
      ids: [ADA, TUNDE],
      errors: [],
    });
  });

  it('refuses junk, nothing, and more than the batch cap', async () => {
    expect((await check({ ids: 'nope' })).errors).toEqual(['ids']);
    expect((await check({})).errors).toEqual(['ids']);
    const many = Array.from(
      { length: PRESENCE_BATCH_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(',');
    expect((await check({ ids: many })).errors).toEqual(['ids']);
  });
});

describe('PresenceGateway', () => {
  function gateway() {
    const delegates = {
      presenceVisibleIds: jest.fn((_: string, ids: string[]) =>
        Promise.resolve(ids.filter((id) => id !== HIDDEN)),
      ),
    };
    const presence = {
      bindServer: jest.fn(),
      connected: jest.fn().mockResolvedValue(undefined),
      disconnected: jest.fn(),
      watch: jest.fn((_: Socket, ids: string[]) => ids),
      unwatch: jest.fn(),
      lookup: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.map((id): PresenceView => ({
            id,
            online: id === ADA,
            lastSeenAt: id === ADA ? null : '2027-09-07T08:00:00.000Z',
          })),
        ),
      ),
    };
    const gw = new PresenceGateway(
      delegates as unknown as DelegatesService,
      presence as unknown as PresenceService,
    );
    return { gw, delegates, presence };
  }
  const socket = (user?: { id: string; role: string }) => ({
    data: { user } as Record<string, unknown>,
    join: jest.fn(),
  });

  it('tracks a delegate’s sockets, not console staff or anonymous ones', () => {
    const { gw, presence } = gateway();
    const delegate = socket({ id: ADA, role: 'standard' });
    gw.handleConnection(delegate as unknown as Socket);
    expect(presence.connected).toHaveBeenCalledWith(ADA);
    expect(delegate.join).toHaveBeenCalledWith(`presence:self:${ADA}`);
    gw.handleDisconnect(delegate as unknown as Socket);
    expect(presence.disconnected).toHaveBeenCalledWith(ADA);

    const staff = socket({ id: TUNDE, role: 'admin' });
    gw.handleConnection(staff as unknown as Socket);
    gw.handleDisconnect(staff as unknown as Socket);
    gw.handleDisconnect(socket() as unknown as Socket);
    expect(presence.connected).toHaveBeenCalledTimes(1);
    expect(presence.disconnected).toHaveBeenCalledTimes(1);
  });

  it('watch joins only permitted ids and acks everyone’s status, hidden as offline', async () => {
    const { gw, presence } = gateway();
    const s = socket({ id: ME, role: 'standard' });

    const ack = await gw.watch(s as unknown as Socket, [
      ADA,
      HIDDEN,
      TUNDE,
      'junk',
      42,
    ]);

    expect(presence.watch).toHaveBeenCalledWith(s, [ADA, TUNDE]);
    expect(ack.presence).toEqual([
      { id: ADA, online: true, lastSeenAt: null },
      { id: HIDDEN, online: false, lastSeenAt: null },
      { id: TUNDE, online: false, lastSeenAt: '2027-09-07T08:00:00.000Z' },
    ]);
  });

  it('watch takes a single id too, and ignores an unauthenticated socket', async () => {
    const { gw, delegates } = gateway();
    await expect(
      gw.watch(socket({ id: ME, role: 'standard' }) as unknown as Socket, ADA),
    ).resolves.toEqual({
      presence: [{ id: ADA, online: true, lastSeenAt: null }],
    });
    await expect(
      gw.watch(socket() as unknown as Socket, [ADA]),
    ).resolves.toEqual({ presence: [] });
    expect(delegates.presenceVisibleIds).toHaveBeenCalledTimes(1);
  });
});

describe('RealtimeService room counters skip presence rooms', () => {
  it('never publishes presence room sizes to Redis', async () => {
    const adapter = new EventEmitter() as EventEmitter & {
      rooms: Map<string, Set<string>>;
      sids: Map<string, Set<string>>;
    };
    adapter.rooms = new Map([
      [`presence:${ADA}`, new Set(['s1'])],
      [`presence:self:${ME}`, new Set(['s1'])],
      ['session:x', new Set(['s1'])],
    ]);
    adapter.sids = new Map([['s1', new Set(['s1'])]]);
    const hset = jest.fn();
    const pipeline = {
      hset: jest.fn((...args: unknown[]) => {
        hset(...args);
        return pipeline;
      }),
      hdel: jest.fn(() => pipeline),
      exec: jest.fn().mockResolvedValue([]),
    };
    const redis = {
      pipeline: () => pipeline,
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const realtime = new RealtimeService(redis as unknown as Redis);
    realtime.bindServer({
      of: () => ({ adapter }),
    } as unknown as Server);

    adapter.emit('join-room', `presence:${ADA}`, 's1');
    adapter.emit('join-room', 'session:x', 's1');
    await realtime.flush();

    const rooms = hset.mock.calls.map(([key]) => key as string);
    expect(rooms).toContain('rt:room:session:x');
    expect(rooms.some((k) => k.includes('presence:'))).toBe(false);
    await realtime.onModuleDestroy();
  });
});
