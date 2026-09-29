import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService } from './delegates.service';
import type { DelegateBlock } from './entities/delegate-block.entity';
import type { DelegateConnection } from './entities/delegate-connection.entity';
import type { Delegate } from './entities/delegate.entity';

/**
 * Blocking, reporting and the "Attending" list on a profile. What matters: a
 * block also ends the connection both ways, nobody can report or block
 * themselves, and a delegate who hid themselves from the directory shows no
 * events to anyone else.
 */
function build(people: Partial<Delegate>[]) {
  const deletes: { sql: string; params: Record<string, unknown> }[] = [];
  const connections = {
    createQueryBuilder: jest.fn(() => {
      const qb = {
        delete: () => qb,
        where: (sql: string, params: Record<string, unknown>) => {
          deletes.push({ sql, params });
          return qb;
        },
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      return qb;
    }),
  };
  const blocks = {
    createQueryBuilder: jest.fn(() => {
      const qb = {
        insert: () => qb,
        values: () => qb,
        orIgnore: () => qb,
        execute: jest.fn().mockResolvedValue({}),
      };
      return qb;
    }),
  };
  const query = jest.fn().mockResolvedValue([
    { id: 'e1', name: 'GS-27', coverImage: 'edition-covers/gs27.jpg' },
    { id: 'e2', name: 'GS-26', coverImage: null },
  ]);
  const storage = {
    resolveStoredUrl: jest.fn((v: string | null) =>
      Promise.resolve(v ? `https://signed/${v}` : null),
    ),
  };
  const delegates = {
    findOneBy: jest.fn(({ id }: { id: string }) =>
      Promise.resolve(people.find((p) => p.id === id) ?? null),
    ),
    query,
  };
  const service = new DelegatesService(
    delegates as unknown as Repository<Delegate>,
    {} as Repository<never>,
    connections as unknown as Repository<DelegateConnection>,
    {} as Repository<never>,
    {} as Repository<never>,
    blocks as unknown as Repository<DelegateBlock>,
    {} as RealtimeService,
    storage as unknown as StorageService,
    {} as Queue,
    {} as DataSource,
    {} as CatalogService,
  );
  return { service, deletes, query };
}

describe('DelegatesService network safety', () => {
  const people: Partial<Delegate>[] = [
    { id: 'ada', flagged: false, directoryVisible: true },
    { id: 'tunde', flagged: false, directoryVisible: true },
    { id: 'hidden', flagged: false, directoryVisible: false },
    { id: 'flagged', flagged: true, directoryVisible: true },
  ];

  it('removes the connection in both directions when blocking', async () => {
    const { service, deletes } = build(people);
    await service.blockDelegate('ada', 'tunde');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params).toEqual({ a: 'ada', b: 'tunde' });
    expect(deletes[0].sql).toContain(
      '"fromDelegateId" = :a AND "toDelegateId" = :b',
    );
    expect(deletes[0].sql).toContain(
      '"fromDelegateId" = :b AND "toDelegateId" = :a',
    );
  });

  it('refuses to report yourself or someone who does not exist', async () => {
    const { service } = build(people);
    await expect(service.assertReportable('ada', 'ada')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.assertReportable('ada', 'ghost'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.assertReportable('ada', 'tunde'),
    ).resolves.toBeUndefined();
  });

  it('lists a visible delegate’s events, newest first, drafts excluded, covers signed', async () => {
    const { service, query } = build(people);
    // the stored key is swapped for a signed URL, as on edition cards
    await expect(service.delegateEditions('tunde', 'ada')).resolves.toEqual([
      {
        id: 'e1',
        name: 'GS-27',
        coverUrl: 'https://signed/edition-covers/gs27.jpg',
      },
      { id: 'e2', name: 'GS-26', coverUrl: null },
    ]);
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('e."coverImage"');
    expect(sql).toContain(`e.status <> 'draft'`);
    expect(sql).toContain('ORDER BY e."startsAt" DESC');
    expect(params).toEqual(['tunde']);
  });

  it('shows a hidden delegate’s events to themselves only', async () => {
    const { service, query } = build(people);
    await expect(service.delegateEditions('hidden', 'ada')).resolves.toEqual(
      [],
    );
    expect(query).not.toHaveBeenCalled();
    await service.delegateEditions('hidden', 'hidden');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('404s a flagged or unknown delegate', async () => {
    const { service } = build(people);
    await expect(
      service.delegateEditions('flagged', 'ada'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.delegateEditions('ghost', 'ada'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
