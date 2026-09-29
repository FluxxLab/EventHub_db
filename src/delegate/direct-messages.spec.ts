import { BadRequestException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import type { CatalogService } from '../catalog/catalog.service';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import { DelegatesService } from './delegates.service';
import type { Delegate } from './entities/delegate.entity';
import type { DirectMessage } from './entities/direct-message.entity';

/**
 * A DM thread opens on its latest messages, not its first hundred, and the
 * conversations list is answered by Postgres (last message per pair, one
 * grouped unread count) rather than by loading the caller's whole history.
 */
const msg = (
  id: string,
  minute: number,
  over: Partial<DirectMessage> = {},
): DirectMessage => ({
  id,
  pairKey: 'ada:tunde',
  senderId: 'tunde',
  recipientId: 'ada',
  body: `message ${id}`,
  replyToId: null,
  audioKey: null,
  audioDurationMs: null,
  audioContentType: null,
  readAt: null,
  createdAt: new Date(Date.UTC(2027, 8, 7, 9, minute)),
  ...over,
});

function build(page: DirectMessage[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const updates: { ids: string[] }[] = [];
  const selectQb: Record<string, unknown> = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ]) {
    selectQb[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return selectQb;
    };
  }
  selectQb.getMany = jest.fn().mockResolvedValue(page);
  const updateQb = {
    update: () => updateQb,
    set: () => updateQb,
    whereInIds: (ids: string[]) => {
      updates.push({ ids });
      return updateQb;
    },
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const messages = {
    createQueryBuilder: jest.fn((alias?: string) =>
      alias ? selectQb : updateQb,
    ),
    findBy: jest.fn().mockResolvedValue([]),
    query: jest.fn(),
  };
  const reactions = { find: jest.fn().mockResolvedValue([]) };
  const delegates = { find: jest.fn().mockResolvedValue([]) };
  const storage = {
    resolveAvatar: jest.fn((v: string | null) =>
      Promise.resolve(v ? `https://signed/${v}` : null),
    ),
  };
  const service = new DelegatesService(
    delegates as unknown as Repository<Delegate>,
    {} as Repository<never>,
    {} as Repository<never>,
    messages as unknown as Repository<DirectMessage>,
    reactions as unknown as Repository<never>,
    {} as Repository<never>,
    {} as RealtimeService,
    storage as unknown as StorageService,
    {} as Queue,
    {} as DataSource,
    {} as CatalogService,
  );
  return { service, calls, updates, messages, delegates };
}

describe('DelegatesService.listThread', () => {
  it('fetches the newest page and returns it oldest to newest', async () => {
    // the database answers newest first (DESC + LIMIT)
    const { service, calls } = build([
      msg('m3', 3),
      msg('m2', 2),
      msg('m1', 1),
    ]);
    const rows = await service.listThread('ada', 'tunde', 3);
    expect(rows.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(calls).toContainEqual({
      method: 'orderBy',
      args: ['m.createdAt', 'DESC'],
    });
    expect(calls).toContainEqual({ method: 'limit', args: [3] });
    expect(calls.find((c) => c.method === 'andWhere')).toBeUndefined();
  });

  it('marks read exactly the caller’s unread messages on the page', async () => {
    const { service, updates } = build([
      msg('m3', 3),
      msg('m2', 2, { senderId: 'ada', recipientId: 'tunde' }),
      msg('m1', 1, { readAt: new Date() }),
    ]);
    await service.listThread('ada', 'tunde');
    expect(updates).toEqual([{ ids: ['m3'] }]);
  });

  it('pages back with a before cursor', async () => {
    const { service, calls } = build([msg('m1', 1)]);
    await service.listThread('ada', 'tunde', 50, '2027-09-07T09:02:00.000Z');
    const cursor = calls.find((c) => c.method === 'andWhere')!;
    expect(cursor.args[0]).toBe('m.createdAt < :before');
    expect(cursor.args[1]).toEqual({
      before: new Date('2027-09-07T09:02:00.000Z'),
    });
  });

  it('refuses a cursor that is not a date', async () => {
    const { service } = build();
    await expect(
      service.listThread('ada', 'tunde', 50, 'yesterday'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DelegatesService.listConversations', () => {
  it('asks Postgres for the last message per pair and one grouped unread count', async () => {
    const { service, messages, delegates } = build();
    messages.query
      .mockResolvedValueOnce([
        {
          pairKey: 'ada:tunde',
          senderId: 'tunde',
          recipientId: 'ada',
          body: 'see you at 10',
          createdAt: new Date('2027-09-07T09:00:00Z'),
        },
        {
          pairKey: 'ada:grace',
          senderId: 'ada',
          recipientId: 'grace',
          body: 'thanks!',
          createdAt: new Date('2027-09-07T10:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([{ pairKey: 'ada:tunde', unread: '2' }]);
    delegates.find.mockResolvedValue([
      { id: 'tunde', name: 'Tunde', avatarUrl: 'avatars/tunde' },
      { id: 'grace', name: 'Grace', avatarUrl: null },
    ]);

    const list = await service.listConversations('ada');

    const [lastSql, lastParams] = messages.query.mock.calls[0] as [
      string,
      string[],
    ];
    expect(lastSql).toContain('DISTINCT ON ("pairKey")');
    expect(lastSql).toContain('ORDER BY "pairKey", "createdAt" DESC');
    expect(lastParams).toEqual(['ada']);
    const [unreadSql] = messages.query.mock.calls[1] as [string];
    expect(unreadSql).toContain('"readAt" IS NULL');
    expect(unreadSql).toContain('GROUP BY "pairKey"');

    // newest thread first, same response shape as before
    expect(list.map((c) => c.delegate.id)).toEqual(['grace', 'tunde']);
    expect(list[1]).toMatchObject({
      lastMessage: {
        body: 'see you at 10',
        senderId: 'tunde',
        createdAt: new Date('2027-09-07T09:00:00Z'),
      },
      unread: 2,
    });
    expect(list[0].unread).toBe(0);
    expect(list[1].delegate.avatarUrl).toBe('https://signed/avatars/tunde');
  });

  it('answers an empty inbox with one query', async () => {
    const { service, messages, delegates } = build();
    messages.query.mockResolvedValueOnce([]);
    await expect(service.listConversations('ada')).resolves.toEqual([]);
    expect(messages.query).toHaveBeenCalledTimes(1);
    expect(delegates.find).not.toHaveBeenCalled();
  });
});
