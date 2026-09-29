import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService } from './delegates.service';
import { AccessTier, Delegate } from './entities/delegate.entity';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));

/**
 * An edition's attendee list is the directory narrowed to one edition's
 * audience. The cases that matter are the people who must not appear: the
 * flagged, staff, accounts someone else's payment created and nobody has
 * claimed, and anyone on the other side of a block in either direction.
 */
function build(rows: Partial<Delegate>[] = []) {
  const wheres: { sql: string; params?: Record<string, unknown> }[] = [];
  const qb = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
  };
  for (const key of ['where', 'andWhere'] as const) {
    qb[key].mockImplementation(
      (sql: string, params?: Record<string, unknown>) => {
        wheres.push({ sql, params });
        return qb;
      },
    );
  }
  for (const key of ['orderBy', 'limit', 'offset'] as const) {
    qb[key].mockReturnValue(qb);
  }
  const delegateRepository = { createQueryBuilder: jest.fn(() => qb) };
  const storage = {
    resolveAvatar: jest.fn((key: string | null) =>
      Promise.resolve(key ? `https://signed/${key}` : null),
    ),
  };
  const unused = {};
  const service = new DelegatesService(
    delegateRepository as unknown as Repository<Delegate>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as RealtimeService,
    storage as unknown as StorageService,
    unused as Queue,
    unused as DataSource,
    {} as CatalogService,
  );
  const find = (needle: string) => wheres.find((w) => w.sql.includes(needle));
  return { service, qb, wheres, find };
}

describe('DelegatesService.listEditionAttendees', () => {
  it('scopes to the edition audience, tickets included', async () => {
    const { service, find } = build();
    await service.listEditionAttendees('e1', 'me', {});
    const audience = find('d.id IN');
    expect(audience?.params).toEqual({ editionId: 'e1' });
    expect(audience?.sql).toContain('FROM tickets t');
    expect(audience?.sql).toContain('session_bookmarks');
    expect(audience?.sql).toContain('session_attendance');
  });

  it('leaves out flagged accounts and staff', async () => {
    const { service, find } = build();
    await service.listEditionAttendees('e1', 'me', {});
    expect(find('d.flagged')?.params).toEqual({ f: false });
    expect(find('d.accessTier NOT IN')?.params).toEqual({
      staff: [
        AccessTier.ADMIN,
        AccessTier.SESSION_ADMIN,
        AccessTier.EVENT_ADMIN,
      ],
    });
  });

  it('leaves out unclaimed ticket-holder accounts', async () => {
    const { service, find } = build();
    await service.listEditionAttendees('e1', 'me', {});
    expect(find('ANY(d.tags)')?.params).toEqual({ holder: 'ticket-holder' });
  });

  it('leaves out anyone blocked in either direction, but not the caller', async () => {
    const { service, find, wheres } = build();
    await service.listEditionAttendees('e1', 'me', {});
    const block = find('delegate_blocks');
    expect(block?.params).toEqual({ me: 'me' });
    expect(block?.sql).toMatch(/"blockerId" = :me AND b\."blockedId" = d\.id/);
    expect(block?.sql).toMatch(/"blockerId" = d\.id AND b\."blockedId" = :me/);
    // nothing excludes the caller's own row
    expect(wheres.some((w) => /d\.id\s*(<>|!=)/.test(w.sql))).toBe(false);
  });

  it('searches name, organisation and country, orders by name, pages 50 by default', async () => {
    const { service, qb, find } = build();
    await service.listEditionAttendees('e1', 'me', { q: '  Ada ' });
    expect(find('ILIKE')?.params).toEqual({ s: '%Ada%' });
    expect(qb.orderBy).toHaveBeenCalledWith('d.name', 'ASC');
    expect(qb.limit).toHaveBeenCalledWith(50);
    expect(qb.offset).toHaveBeenCalledWith(0);
  });

  it('returns directory views with signed avatars and the total', async () => {
    const { service } = build([
      {
        id: 'd1',
        name: 'Ada',
        organisation: 'NESG',
        country: 'Nigeria',
        accessTier: AccessTier.STANDARD,
        title: null,
        track: null,
        tags: [],
        tracks: [],
        avatarUrl: 'avatars/d1',
        // never leaks into the directory view
        email: 'ada@example.com',
      },
    ]);
    const result = await service.listEditionAttendees('e1', 'me', {
      limit: 10,
      offset: 20,
    });
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        id: 'd1',
        name: 'Ada',
        organisation: 'NESG',
        country: 'Nigeria',
        accessTier: AccessTier.STANDARD,
        title: null,
        track: null,
        tags: [],
        tracks: [],
        avatarUrl: 'https://signed/avatars/d1',
      },
    ]);
  });
});
