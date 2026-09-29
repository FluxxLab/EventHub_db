import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import type { EditionsService } from '../editions/editions.service';
import type { AdmissionService } from './admission.service';
import { Order, OrderStatus } from './entities/order.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { Voucher } from './entities/voucher.entity';
import type { PaymentProvider } from './payment/payment-provider.interface';
import { TicketingService } from './ticketing.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('placeholder-hash'),
}));

/**
 * A buyer pays for themselves and two colleagues. Each place must become its
 * own ticket in the right account: the buyer's own, an existing colleague's,
 * and a new unclaimed account for the colleague who has none. Only the
 * people who did not pay are emailed.
 */
const STANDARD = 'aaaa1111-1111-4111-8111-111111111111';

function setup(order: Partial<Order>) {
  const delegates: Partial<Delegate>[] = [
    { id: 'buyer', email: 'ada@example.com', name: 'Ada Okafor' },
    { id: 'tunde', email: 'tunde@nesg.org', name: 'Tunde Bakare' },
  ];
  const tickets: Partial<Ticket>[] = [];
  const type = {
    id: STANDARD,
    name: 'Standard',
    section: 'General',
    capacity: null,
    sold: 0,
  } as TicketType;
  const theOrder = {
    id: 'o1',
    delegateId: 'buyer',
    editionId: 'e1',
    status: OrderStatus.PENDING,
    lines: [
      {
        ticketTypeId: STANDARD,
        name: 'Standard',
        quantity: 3,
        unitPrice: 15000,
      },
    ],
    attendees: [],
    voucherCode: null,
    guestName: 'Ada Okafor',
    guestEmail: 'ada@example.com',
    ...order,
  } as Order;

  const repos = new Map<unknown, Record<string, jest.Mock>>([
    [
      Order,
      {
        findOne: jest.fn().mockResolvedValue(theOrder),
        save: jest.fn((o: Order) => Promise.resolve(o)),
      },
    ],
    [
      TicketType,
      {
        findOne: jest.fn().mockResolvedValue(type),
        save: jest.fn((t: TicketType) => Promise.resolve(t)),
      },
    ],
    [
      Ticket,
      {
        create: jest.fn((v: Partial<Ticket>) => v),
        save: jest.fn((v: Partial<Ticket>) => {
          tickets.push(v);
          return Promise.resolve(v);
        }),
        existsBy: jest.fn().mockResolvedValue(false),
      },
    ],
    [
      Delegate,
      {
        find: jest.fn(({ where }: { where: { email: { _value: string[] } } }) =>
          Promise.resolve(
            delegates.filter((d) => where.email._value.includes(d.email!)),
          ),
        ),
        findOne: jest.fn(
          ({ where }: { where: { id?: string; email?: string } }) =>
            Promise.resolve(
              delegates.find((d) =>
                where.id ? d.id === where.id : d.email === where.email,
              ) ?? null,
            ),
        ),
        create: jest.fn((v: Partial<Delegate>) => v),
        save: jest.fn((v: Partial<Delegate>) => {
          const saved = { ...v, id: `new-${delegates.length}` };
          delegates.push(saved);
          return Promise.resolve(saved);
        }),
      },
    ],
    [Voucher, { increment: jest.fn() }],
  ]);
  const manager = { getRepository: (entity: unknown) => repos.get(entity) };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
    getRepository: (entity: unknown) => repos.get(entity),
  } as unknown as DataSource;
  const email = { send: jest.fn().mockResolvedValue(undefined) };
  const service = new TicketingService(
    {} as Repository<TicketType>,
    {
      findOne: jest.fn().mockResolvedValue({ ...theOrder }),
    } as unknown as Repository<Order>,
    {} as Repository<Ticket>,
    {} as Repository<Voucher>,
    dataSource,
    {
      card: jest.fn().mockResolvedValue({ id: 'e1', name: 'GS-27 Summit' }),
    } as unknown as EditionsService,
    {} as ConfigService,
    {} as PaymentProvider,
    {} as AdmissionService,
    email,
  );
  return { service, tickets, delegates, email, order: theOrder };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('TicketingService.settle with named attendees', () => {
  const attendees = [
    { ticketTypeId: STANDARD, name: 'Ada Okafor', email: 'ada@example.com' },
    { ticketTypeId: STANDARD, name: 'Tunde Bakare', email: 'tunde@nesg.org' },
    { ticketTypeId: STANDARD, name: 'Grace Obi', email: 'grace@example.org' },
  ];

  it('issues one single-entry ticket per person, in each person’s account', async () => {
    const { service, tickets } = setup({ attendees });
    await service.settle('o1', 'ref1');
    expect(tickets).toHaveLength(3);
    expect(
      tickets.map((t) => [
        t.guestName,
        t.delegateId,
        t.purchasedBy,
        t.quantity,
      ]),
    ).toEqual([
      ['Ada Okafor', 'buyer', null, 1],
      ['Tunde Bakare', 'tunde', 'buyer', 1],
      ['Grace Obi', 'new-2', 'buyer', 1],
    ]);
  });

  it('creates an unclaimed account for a holder with none: no consent, tagged, no known password', async () => {
    const { service, delegates } = setup({ attendees });
    await service.settle('o1', 'ref1');
    expect(delegates[2]).toMatchObject({
      email: 'grace@example.org',
      name: 'Grace Obi',
      hasChosenPassword: false,
      consentAt: null,
      tags: ['ticket-holder'],
      passwordHash: 'placeholder-hash',
    });
  });

  it('emails the two colleagues, not the buyer, and says which ones must sign up', async () => {
    const { service, email } = setup({ attendees });
    await service.settle('o1', 'ref1');
    await flush();
    const sent = email.send.mock.calls.map((c: string[]) => [
      c[0],
      c[2].includes('sign up with this email'),
    ]);
    expect(sent).toEqual([
      ['tunde@nesg.org', false],
      ['grace@example.org', true],
    ]);
    expect(email.send.mock.calls[0][1]).toBe('Your ticket to GS-27 Summit');
  });

  it('keeps the old behaviour for orders without attendees: one ticket for the line, to the buyer', async () => {
    const { service, tickets, email } = setup({ attendees: [] });
    await service.settle('o1', 'ref1');
    await flush();
    expect(tickets).toEqual([
      expect.objectContaining({
        delegateId: 'buyer',
        quantity: 3,
        purchasedBy: null,
      }),
    ]);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does nothing for an order already paid', async () => {
    const { service, tickets } = setup({ attendees, status: OrderStatus.PAID });
    await service.settle('o1', 'ref1');
    expect(tickets).toHaveLength(0);
  });
});
