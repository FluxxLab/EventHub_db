import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import { BoothStamp } from './entities/booth-stamp.entity';
import { Booth } from './entities/booth.entity';
import { PassportService } from './passport.service';

/**
 * The passport is a checklist, so the cases that matter are the counts
 * being right, "complete" meaning every stand and not most of them, and a
 * second scan at the same stand not being a second stamp.
 */
const booth = (over: Partial<Booth> = {}): Booth => ({
  id: 'b1',
  editionId: 'gs26',
  name: 'Stand A',
  code: 'K7M2PX',
  description: null,
  location: 'Hall B',
  sortOrder: 0,
  isActive: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const stamp = (boothId: string, at = '2026-09-07T11:00:00Z'): BoothStamp => ({
  id: `s-${boothId}`,
  boothId,
  delegateId: 'd1',
  createdAt: new Date(at),
});

function build() {
  const insert: { identifiers: { id: string }[] } = {
    identifiers: [{ id: 'new' }],
  };
  const raw: { rows: unknown[] } = { rows: [] };
  // one chain object serves both the insert (...execute) and the grouped
  // count (...getRawMany) builders; every step returns itself
  const qb = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockImplementation(() => Promise.resolve(insert)),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockImplementation(() => Promise.resolve(raw.rows)),
  };
  const booths = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    existsBy: jest.fn().mockResolvedValue(false),
    create: jest.fn().mockImplementation((v: Partial<Booth>) => v),
    save: jest.fn().mockImplementation((v: Booth) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const stamps = {
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const dataSource = { query: jest.fn().mockResolvedValue([]) };
  const editions = {
    current: jest.fn().mockResolvedValue({ id: 'gs26' }),
    findById: jest.fn().mockResolvedValue({ id: 'gs26' }),
  };
  const service = new PassportService(
    booths as unknown as Repository<Booth>,
    stamps as unknown as Repository<BoothStamp>,
    dataSource as unknown as DataSource,
    editions as unknown as EditionsService,
  );
  return { service, booths, stamps, qb, insert, raw, dataSource, editions };
}

describe('PassportService.view', () => {
  it('counts stamped stands and is not complete while one is missing', async () => {
    const { service, booths, stamps } = build();
    booths.find.mockResolvedValue([
      booth({ id: 'b1' }),
      booth({ id: 'b2', name: 'Stand B' }),
      booth({ id: 'b3', name: 'Stand C' }),
    ]);
    stamps.find.mockResolvedValue([stamp('b1'), stamp('b3')]);

    const view = await service.view('d1', 'gs26');

    expect(view.editionId).toBe('gs26');
    expect(view.stamped).toBe(2);
    expect(view.total).toBe(3);
    expect(view.complete).toBe(false);
    expect(view.booths.map((b) => b.stamped)).toEqual([true, false, true]);
    expect(view.booths[0].stampedAt).toBe('2026-09-07T11:00:00.000Z');
    expect(view.booths[1].stampedAt).toBeNull();
    // only active stands count, in display order
    expect(booths.find).toHaveBeenCalledWith({
      where: { editionId: 'gs26', isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  });

  it('is complete when every active stand is stamped', async () => {
    const { service, booths, stamps } = build();
    booths.find.mockResolvedValue([booth({ id: 'b1' }), booth({ id: 'b2' })]);
    stamps.find.mockResolvedValue([stamp('b1'), stamp('b2')]);
    const view = await service.view('d1', 'gs26');
    expect(view.complete).toBe(true);
    expect(view.stamped).toBe(2);
  });

  it('is empty, not complete, when the edition has no stands yet', async () => {
    const { service, stamps } = build();
    const view = await service.view('d1', 'gs26');
    expect(view).toEqual({
      editionId: 'gs26',
      booths: [],
      stamped: 0,
      total: 0,
      complete: false,
    });
    expect(stamps.find).not.toHaveBeenCalled();
  });

  it('falls back to the current edition when none is named', async () => {
    const { service, booths, editions } = build();
    await service.view('d1');
    expect(editions.current).toHaveBeenCalled();
    expect(booths.find).toHaveBeenCalledWith({
      where: { editionId: 'gs26', isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  });

  it('404s between summits, when there is nothing to stamp', async () => {
    const { service, editions } = build();
    editions.current.mockResolvedValue(null);
    await expect(service.view('d1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PassportService.stamp', () => {
  it('stamps the stand on the first scan and returns the passport', async () => {
    const { service, booths, stamps, qb } = build();
    booths.findOne.mockResolvedValue(booth());
    booths.find.mockResolvedValue([booth()]);
    stamps.find.mockResolvedValue([stamp('b1')]);

    const result = await service.stamp('d1', 'k7m2px');

    // the code is read off a sign, so case and whitespace are forgiven
    expect(booths.findOne).toHaveBeenCalledWith({ where: { code: 'K7M2PX' } });
    expect(qb.values).toHaveBeenCalledWith({ boothId: 'b1', delegateId: 'd1' });
    expect(qb.orIgnore).toHaveBeenCalled();
    expect(result.alreadyStamped).toBe(false);
    expect(result.booth).toEqual({ id: 'b1', name: 'Stand A' });
    expect(result.complete).toBe(true);
  });

  it('reports a repeat scan rather than stamping twice or failing', async () => {
    const { service, booths, stamps, insert } = build();
    booths.findOne.mockResolvedValue(booth());
    booths.find.mockResolvedValue([booth()]);
    stamps.find.mockResolvedValue([stamp('b1', '2026-09-07T09:30:00Z')]);
    insert.identifiers = []; // ON CONFLICT DO NOTHING inserted no row

    const result = await service.stamp('d1', 'K7M2PX');

    expect(result.alreadyStamped).toBe(true);
    expect(result.stamped).toBe(1);
    expect(result.booths[0].stampedAt).toBe('2026-09-07T09:30:00.000Z');
  });

  it('404s for a code nobody printed', async () => {
    const { service, qb } = build();
    await expect(service.stamp('d1', 'NOPE99')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(qb.execute).not.toHaveBeenCalled();
  });

  it('404s for a stand that has been switched off, same as an unknown code', async () => {
    const { service, booths, qb } = build();
    booths.findOne.mockResolvedValue(booth({ isActive: false }));
    await expect(service.stamp('d1', 'K7M2PX')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(qb.execute).not.toHaveBeenCalled();
  });
});

describe('PassportService.listBooths', () => {
  it('attaches the stamp count to every stand, zero for the untouched ones', async () => {
    const { service, booths, raw } = build();
    booths.find.mockResolvedValue([booth({ id: 'b1' }), booth({ id: 'b2' })]);
    raw.rows = [{ boothId: 'b1', count: '14' }];
    const rows = await service.listBooths('gs26');
    expect(rows.map((r) => r.stamps)).toEqual([14, 0]);
    expect(rows[0].code).toBe('K7M2PX');
  });
});

describe('PassportService.draw', () => {
  it('asks Postgres for delegates who stamped every active stand', async () => {
    const { service, booths, dataSource } = build();
    booths.find.mockResolvedValue([booth({ id: 'b1' }), booth({ id: 'b2' })]);
    dataSource.query.mockResolvedValue([
      {
        id: 'd1',
        name: 'Ada',
        email: 'ada@example.org',
        organisation: null,
        completedAt: new Date('2026-09-07T15:00:00Z'),
      },
    ]);

    const winners = await service.draw('gs26', 50);

    expect(winners).toEqual([
      {
        id: 'd1',
        name: 'Ada',
        email: 'ada@example.org',
        organisation: null,
        completedAt: '2026-09-07T15:00:00.000Z',
      },
    ]);
    // every active stand, the stand count to match, and the count capped
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
      ['b1', 'b2'],
      2,
      20,
    ]);
  });

  it('draws nobody when there are no stands, without touching the database', async () => {
    const { service, dataSource } = build();
    expect(await service.draw('gs26', 1)).toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
