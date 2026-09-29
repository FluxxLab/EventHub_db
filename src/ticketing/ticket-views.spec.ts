import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type {
  EditionCardView,
  EditionsService,
} from '../editions/editions.service';
import type { AdmissionService } from './admission.service';
import type { Order } from './entities/order.entity';
import type { TicketType } from './entities/ticket-type.entity';
import type { Ticket } from './entities/ticket.entity';
import type { Voucher } from './entities/voucher.entity';
import type { PaymentProvider } from './payment/payment-provider.interface';
import { TicketingService } from './ticketing.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('placeholder-hash'),
}));

/**
 * My Tickets hangs an edition card off every ticket. A delegate with tickets
 * to several editions used to cost one full card build (edition lookup,
 * audience, ratings) per edition, one after another; it is now one batch.
 */
function setup(rows: Partial<Ticket>[]) {
  const tickets = {
    find: jest.fn().mockResolvedValue(rows),
  };
  const editions = {
    card: jest.fn(),
    cardsByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [
            id,
            { id, name: `Edition ${id}` } as EditionCardView,
          ]),
        ),
      ),
    ),
  };
  const admission = {
    usage: jest.fn().mockResolvedValue(new Map()),
    qrFor: jest.fn((id: string) => `qr-${id}`),
  };
  const service = new TicketingService(
    {} as Repository<TicketType>,
    {} as Repository<Order>,
    tickets as unknown as Repository<Ticket>,
    {} as Repository<Voucher>,
    {} as DataSource,
    editions as unknown as EditionsService,
    {} as ConfigService,
    {} as PaymentProvider,
    admission as unknown as AdmissionService,
    { send: jest.fn() },
  );
  return { service, editions, admission };
}

const ticket = (id: string, editionId: string, delegateId = 'me') =>
  ({
    id,
    editionId,
    delegateId,
    purchasedBy: null,
    guestName: 'Ada',
    guestEmail: 'ada@example.com',
    createdAt: new Date('2027-01-01T00:00:00Z'),
  }) as Partial<Ticket>;

describe('TicketingService.myTickets edition cards', () => {
  it('builds every edition card in one batch, never card() per edition', async () => {
    const { service, editions } = setup([
      ticket('t1', 'gs27'),
      ticket('t2', 'yis27'),
      ticket('t3', 'gs27'),
    ]);
    const views = await service.myTickets('me');
    expect(editions.cardsByIds).toHaveBeenCalledTimes(1);
    expect(editions.cardsByIds).toHaveBeenCalledWith(['gs27', 'yis27', 'gs27']);
    expect(editions.card).not.toHaveBeenCalled();
    expect(views.map((v) => [v.id, v.edition.id])).toEqual([
      ['t1', 'gs27'],
      ['t2', 'yis27'],
      ['t3', 'gs27'],
    ]);
  });

  it('gives the entry QR to the holder only', async () => {
    const { service } = setup([
      ticket('t1', 'gs27'),
      ticket('t2', 'gs27', 'colleague'),
    ]);
    const views = await service.myTickets('me');
    expect(views.map((v) => v.qr)).toEqual(['qr-t1', null]);
  });
});

describe('TicketingService.myTickets transfer state', () => {
  const gift = (over: Partial<Ticket>) =>
    ({
      ...ticket('g1', 'gs27', 'grace'),
      purchasedBy: 'me',
      ...over,
    }) as Partial<Ticket>;

  it('lets the buyer pass on a gift nobody has been admitted on', async () => {
    const { service } = setup([gift({}), ticket('t1', 'gs27')]);
    const views = await service.myTickets('me');
    expect(views.map((v) => [v.id, v.transferable, v.qr])).toEqual([
      ['g1', true, null],
      ['t1', false, 'qr-t1'],
    ]);
  });

  it('stops offering a transfer once someone is through the gate', async () => {
    const { service, admission } = setup([gift({})]);
    admission.usage.mockResolvedValue(
      new Map([['g1', { admitted: 1, lastAdmittedAt: new Date() }]]),
    );
    const [view] = await service.myTickets('me');
    expect(view.transferable).toBe(false);
  });

  it('never offers the holder a transfer of a ticket someone else bought', async () => {
    const { service } = setup([gift({ delegateId: 'me', purchasedBy: 'ada' })]);
    const [view] = await service.myTickets('me');
    expect(view.transferable).toBe(false);
  });
});
