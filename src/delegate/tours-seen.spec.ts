import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService, MAX_TOURS_SEEN } from './delegates.service';
import { Delegate } from './entities/delegate.entity';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));

function build() {
  const delegateRepository = { query: jest.fn().mockResolvedValue([]) };
  const unused = {};
  const service = new DelegatesService(
    delegateRepository as unknown as Repository<Delegate>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as RealtimeService,
    unused as StorageService,
    unused as Queue,
    unused as DataSource,
    unused as CatalogService,
  );
  return { service, delegateRepository };
}

describe('DelegatesService.markTourSeen', () => {
  it('appends the tour once, atomically, under the cap', async () => {
    const { service, delegateRepository } = build();
    await service.markTourSeen('d1', 'home');
    const [sql, params] = delegateRepository.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('array_append("toursSeen", $2)');
    expect(sql).toContain('NOT ($2 = ANY("toursSeen"))');
    expect(sql).toContain('cardinality("toursSeen") < $3');
    expect(params).toEqual(['d1', 'home', MAX_TOURS_SEEN]);
  });

  it('accepts slug ids and refuses anything else without touching the database', async () => {
    const { service, delegateRepository } = build();
    await expect(
      service.markTourSeen('d1', 'live-captions'),
    ).resolves.toBeUndefined();
    for (const bad of [
      '',
      'Home',
      'a b',
      '-x',
      'x'.repeat(41),
      "home'); DROP",
    ]) {
      await expect(service.markTourSeen('d1', bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(delegateRepository.query).toHaveBeenCalledTimes(1);
  });
});
