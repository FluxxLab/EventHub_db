import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import { TicketType } from './entities/ticket-type.entity';
import { TicketingService } from './ticketing.service';

/**
 * Tier lists. The pricing tab shows only tiers on sale, and only for
 * editions delegates can see. The organiser list shows every tier, including
 * ones taken off sale and tiers of a draft edition, so a tier switched off
 * can be found and switched back on.
 */
const EDITION_ID = '22222222-2222-4222-8222-222222222222';

const tier = (over: Partial<TicketType>): TicketType => ({
  id: 'tt1',
  editionId: EDITION_ID,
  name: 'Standard',
  price: 25000,
  prices: { NGN: 25000 },
  perks: [],
  section: 'General',
  capacity: null,
  sold: 0,
  isActive: true,
  sortOrder: 0,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  ...over,
});

function setup(rows: TicketType[], opts: { editionExists?: boolean } = {}) {
  // Mimics the repository's `where`: every key given must match.
  const find = jest.fn(({ where }: { where: Partial<TicketType> }) =>
    Promise.resolve(
      rows.filter((r) =>
        Object.entries(where).every(([k, v]) => r[k as keyof TicketType] === v),
      ),
    ),
  );
  const types = { find } as unknown as Repository<TicketType>;
  const missing = () =>
    Promise.reject(new NotFoundException('Edition not found'));
  const findById = jest.fn(() =>
    opts.editionExists === false ? missing() : Promise.resolve({}),
  );
  const card = jest.fn(() =>
    opts.editionExists === false ? missing() : Promise.resolve({}),
  );
  const editions = { findById, card } as unknown as EditionsService;
  const none = {} as never;
  const service = new TicketingService(
    types,
    none,
    none,
    none,
    none,
    editions,
    none,
    none,
    none,
    none,
  );
  return { service, find, findById, card };
}

describe('ticket tier lists', () => {
  const rows = [
    tier({ id: 'on', name: 'Standard', isActive: true }),
    tier({ id: 'off', name: 'Early bird', isActive: false }),
  ];

  it('the organiser list includes tiers taken off sale', async () => {
    const { service } = setup(rows);
    const all = await service.allTicketTypes(EDITION_ID);
    expect(all.map((t) => t.id).sort()).toEqual(['off', 'on']);
  });

  it('the pricing tab still shows only tiers on sale', async () => {
    const { service } = setup(rows);
    const onSale = await service.ticketTypes(EDITION_ID);
    expect(onSale.map((t) => t.id)).toEqual(['on']);
  });

  it('the organiser list looks the edition up by id, so drafts work', async () => {
    const { service, findById, card } = setup(rows);
    await service.allTicketTypes(EDITION_ID);
    expect(findById).toHaveBeenCalledWith(EDITION_ID);
    expect(card).not.toHaveBeenCalled();
  });

  it('keeps checkout order: sortOrder, then price', async () => {
    const { service, find } = setup(rows);
    await service.allTicketTypes(EDITION_ID);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { sortOrder: 'ASC', price: 'ASC' } }),
    );
  });

  it('is a 404 for an edition that does not exist', async () => {
    const { service } = setup(rows, { editionExists: false });
    await expect(service.allTicketTypes(EDITION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
