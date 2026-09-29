import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { Delegate } from '../delegate/entities/delegate.entity';
import { Order } from './entities/order.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { ISSUED_PROVIDER, IssueService } from './issue.service';
import { TICKET_HOLDER_TAG } from './ticket-holders';

/**
 * Issuing tickets without payment: nobody gets a second ticket, the tier's
 * capacity holds as it does for a sale, new people get unclaimed accounts,
 * existing profiles are only filled in, and the order is a free one on
 * record.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';
const VIP = '33333333-3333-4333-8333-333333333333';

function setup(
  opts: {
    capacity?: number | null;
    sold?: number;
    holding?: { account: string | null; guest: string | null }[];
    accounts?: Partial<Delegate>[];
  } = {},
) {
  const type = {
    id: VIP,
    editionId: EDITION,
    name: 'VIP',
    section: 'VIP',
    capacity: opts.capacity ?? null,
    sold: opts.sold ?? 0,
  } as TicketType;
  const accounts = [...(opts.accounts ?? [])] as Delegate[];
  const saved = {
    orders: [] as Partial<Order>[],
    tickets: [] as Partial<Ticket>[],
    delegates: [] as Partial<Delegate>[],
    updates: [] as unknown[],
  };

  const repo = (entity: unknown) => {
    if (entity === TicketType)
      return {
        find: jest.fn().mockResolvedValue([type]),
        findOne: jest.fn().mockResolvedValue(type),
        save: jest.fn((t: TicketType) => Promise.resolve(t)),
      };
    if (entity === Delegate)
      return {
        find: jest
          .fn()
          .mockResolvedValue(accounts.map((a) => ({ email: a.email }))),
        findOne: jest.fn(
          ({ where }: { where: { id?: string; email?: string } }) =>
            Promise.resolve(
              where.id
                ? { id: where.id, name: 'Desk Staff', email: 'desk@pic.org' }
                : (accounts.find((a) => a.email === where.email) ?? null),
            ),
        ),
        create: jest.fn((d: Partial<Delegate>) => d),
        save: jest.fn((d: Partial<Delegate>) => {
          const row = { ...d, id: `new-${d.email}` } as Delegate;
          saved.delegates.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn((where: unknown, v: unknown) => {
          saved.updates.push(v);
          return Promise.resolve({});
        }),
      };
    if (entity === Order)
      return {
        create: jest.fn((o: Partial<Order>) => o),
        save: jest.fn((o: Partial<Order>) => {
          saved.orders.push(o);
          return Promise.resolve({ ...o, id: 'order-1' });
        }),
      };
    return {
      create: jest.fn((t: Partial<Ticket>) => t),
      existsBy: jest.fn().mockResolvedValue(false),
      save: jest.fn((t: Partial<Ticket>) => {
        saved.tickets.push(t);
        return Promise.resolve({ ...t, id: `ticket-${saved.tickets.length}` });
      }),
    };
  };
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.holding ?? []),
  };
  const dataSource = {
    getRepository: jest.fn(repo),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    transaction: jest.fn((fn: (m: { getRepository: typeof repo }) => unknown) =>
      fn({ getRepository: repo }),
    ),
  } as unknown as DataSource;
  const editions = {
    card: jest.fn().mockResolvedValue({ id: EDITION, name: 'GS-27 Summit' }),
  } as unknown as EditionsService;
  const send = jest.fn().mockResolvedValue(undefined);
  const email: EmailSender = { send };
  return {
    service: new IssueService(dataSource, editions, email),
    saved,
    type,
    send,
  };
}

const row = (over: Record<string, string> = {}) => ({
  name: 'Ngozi Eze',
  email: 'Ngozi@Example.com ',
  ticketTypeId: VIP,
  ...over,
});

describe('IssueService', () => {
  it('issues free tickets on one order in the staff memberâ€™s name, creating unclaimed accounts', async () => {
    const { service, saved, type } = setup();
    const result = await service.issue(EDITION, 'staff-1', {
      rows: [
        row({ organisation: 'WIPA', title: ' Director ' }),
        row({ name: 'Kwame', email: 'kwame@example.com' }),
      ],
      notify: false,
    });
    expect(result.issued.map((i) => i.email)).toEqual([
      'ngozi@example.com',
      'kwame@example.com',
    ]);
    expect(
      result.issued.every((i) => i.created && i.code.startsWith('PIC-VIP-')),
    ).toBe(true);
    expect(saved.orders[0]).toMatchObject({
      delegateId: 'staff-1',
      total: 0,
      provider: ISSUED_PROVIDER,
      guestName: 'Desk Staff',
      status: 'paid',
    });
    expect(saved.delegates[0]).toMatchObject({
      tags: [TICKET_HOLDER_TAG],
      organisation: 'WIPA',
      title: 'Director',
      hasChosenPassword: false,
    });
    expect(saved.tickets).toHaveLength(2);
    expect(saved.tickets[0]).toMatchObject({
      purchasedBy: null,
      quantity: 1,
      guestEmail: 'ngozi@example.com',
    });
    expect(type.sold).toBe(2);
  });

  it('skips people who already hold a ticket, and repeats in the same list', async () => {
    const { service, saved } = setup({
      holding: [{ account: null, guest: 'ngozi@example.com' }],
    });
    const result = await service.issue(EDITION, 'staff-1', {
      rows: [
        row(),
        row({ name: 'Kwame', email: 'kwame@example.com' }),
        row({ name: 'Kwame again', email: 'KWAME@example.com' }),
      ],
      notify: false,
    });
    expect(result.skipped).toEqual([
      { email: 'kwame@example.com', reason: 'duplicate' },
      { email: 'ngozi@example.com', reason: 'has_ticket' },
    ]);
    expect(result.issued.map((i) => i.email)).toEqual(['kwame@example.com']);
    expect(saved.tickets).toHaveLength(1);
  });

  it('holds the tier to its capacity, all or nothing', async () => {
    const { service, saved } = setup({ capacity: 10, sold: 9 });
    await expect(
      service.issue(EDITION, 'staff-1', {
        rows: [row(), row({ email: 'b@example.com' })],
        notify: false,
      }),
    ).rejects.toThrow('VIP has 1 place left and this would issue 2');
    expect(saved.tickets).toHaveLength(0);
  });

  it('refuses a tier from another event', async () => {
    const { service } = setup();
    await expect(
      service.issue(EDITION, 'staff-1', {
        rows: [row({ ticketTypeId: '44444444-4444-4444-8444-444444444444' })],
        notify: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only fills gaps on an existing profile, and emails when asked', async () => {
    const { service, saved, send } = setup({
      accounts: [
        {
          id: 'd1',
          email: 'ngozi@example.com',
          organisation: 'Her own org',
          title: null,
          country: null,
        },
      ],
    });
    const result = await service.issue(EDITION, 'staff-1', {
      rows: [row({ organisation: 'Spreadsheet org', title: 'Director' })],
      notify: true,
    });
    expect(result.issued[0].created).toBe(false);
    expect(saved.delegates).toHaveLength(0);
    expect(saved.updates[0]).toEqual({
      organisation: 'Her own org',
      title: 'Director',
      country: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(send).toHaveBeenCalledWith(
      'ngozi@example.com',
      'Your ticket to GS-27 Summit',
      expect.stringContaining('issued you a VIP ticket'),
    );
  });
});
