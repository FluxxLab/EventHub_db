import { ConflictException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { CatalogService } from '../catalog/catalog.service';
import type { StorageService } from '../common/storage/storage.service';
import { countLabel, EditionsService } from './editions.service';
import type { Edition } from './entities/edition.entity';

/**
 * Deleting an event: only one with nothing in it. Most event tables have no
 * foreign key, so the service is the only thing between a delete and orphaned
 * tickets and orders.
 */
const ID = '0b6f7c1e-3d6a-4b8e-9a3c-2f1d5e7a9b10';

function build(row: Partial<Edition>, counts: Record<string, number>) {
  const repo = {
    findOne: jest.fn().mockResolvedValue({
      id: ID,
      name: 'GS-27',
      isCurrent: false,
      coverImage: null,
      logoImage: null,
      ...row,
    }),
    delete: jest.fn().mockResolvedValue({}),
  };
  const dataSource = {
    query: jest.fn((sql: string) => {
      if (sql.includes('information_schema'))
        return Promise.resolve(
          ['editions', 'edition_rooms', 'sessions', 'tickets', 'orders'].map(
            (table_name) => ({ table_name }),
          ),
        );
      const table = /FROM "([a-z_]+)"/.exec(sql)![1];
      return Promise.resolve([{ n: counts[table] ?? 0 }]);
    }),
  };
  const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
  const service = new EditionsService(
    repo as unknown as Repository<Edition>,
    dataSource as unknown as DataSource,
    storage as unknown as StorageService,
    {} as Redis,
    {} as CatalogService,
  );
  return { service, repo, dataSource, storage };
}

describe('EditionsService.remove', () => {
  it('deletes an empty event and its uploaded pictures, never counting cascading tables', async () => {
    const { service, repo, dataSource, storage } = build(
      {
        coverImage: 'edition-covers/11111111-1111-4111-8111-111111111111',
        logoImage: 'https://cdn.example.org/l.png',
      },
      { edition_rooms: 4 },
    );
    await service.remove(ID);
    expect(repo.delete).toHaveBeenCalledWith({ id: ID });
    expect(
      dataSource.query.mock.calls.some(([sql]) =>
        String(sql).includes('"edition_rooms"'),
      ),
    ).toBe(false);
    // only our own upload is deleted, not an external logo URL
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('refuses an event that holds sessions, tickets or orders, naming them', async () => {
    const { service, repo } = build({}, { sessions: 12, tickets: 1 });
    await expect(service.remove(ID)).rejects.toThrow(
      '"GS-27" has 12 sessions, 1 ticket.',
    );
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('refuses the event the app shows', async () => {
    const { service, repo } = build({ isCurrent: true }, {});
    await expect(service.remove(ID)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('names tables it has no wording for plainly', () => {
    expect(countLabel('ticket_types', 1)).toBe('1 ticket type');
    expect(countLabel('widget_things', 2)).toBe('2 widget things');
  });
});
