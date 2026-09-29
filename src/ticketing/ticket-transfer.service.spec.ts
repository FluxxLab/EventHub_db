import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Delegate } from '../delegate/entities/delegate.entity';
import type { EditionsService } from '../editions/editions.service';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { Ticket } from './entities/ticket.entity';
import { TicketTransferService } from './ticket-transfer.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('placeholder-hash'),
}));

/**
 * Ada bought Grace a ticket; Grace had no account, so one was made for her,
 * unclaimed. Ada can hand the ticket to someone else until anyone is let in
 * on it; Grace's unused account then goes.
 */
const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date(Date.now() + 30 * 86_400_000);

type Row = Partial<Delegate> & { id: string; email: string };

function setup(
  opts: {
    ticket?: Partial<Ticket>;
    tickets?: Partial<Ticket>[];
    delegates?: Row[];
    admitted?: number;
    endsAt?: Date;
  } = {},
) {
  const delegates: Row[] = opts.delegates ?? [
    { id: 'ada', email: 'ada@example.com', name: 'Ada Okafor', tags: [] },
    {
      id: 'grace',
      email: 'grace@example.org',
      name: 'Grace Obi',
      tags: ['ticket-holder'],
      hasChosenPassword: false,
      consentAt: null,
    },
    {
      id: 'tunde',
      email: 'tunde@nesg.org',
      name: 'Tunde Bakare',
      tags: [],
      hasChosenPassword: true,
      consentAt: new Date(),
    },
  ];
  const tickets: Partial<Ticket>[] = opts.tickets ?? [
    {
      id: TICKET_ID,
      orderId: 'o1',
      delegateId: 'grace',
      purchasedBy: 'ada',
      editionId: 'e1',
      ticketTypeId: 'tt1',
      tierName: 'Standard',
      quantity: 1,
      guestName: 'Grace Obi',
      guestEmail: 'grace@example.org',
      qrVersion: 0,
      ...opts.ticket,
    },
  ];
  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const actual = (row as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && '_type' in v) {
        const op = v as { _type: string; _value: unknown };
        if (op._type === 'not') return actual !== op._value;
        if (op._type === 'in') return (op._value as unknown[]).includes(actual);
      }
      return actual === v;
    });

  const ticketRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(tickets.find((t) => matches(t, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(tickets.filter((t) => matches(t, where))),
    ),
    exists: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(tickets.some((t) => matches(t, where))),
    ),
    count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(tickets.filter((t) => matches(t, where)).length),
    ),
    save: jest.fn((t: Partial<Ticket>) => Promise.resolve(t)),
  };
  const delegateRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(delegates.find((d) => matches(d, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(delegates.filter((d) => matches(d, where))),
    ),
    exists: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(delegates.some((d) => matches(d, where))),
    ),
    create: jest.fn((v: Partial<Delegate>) => v),
    save: jest.fn((v: Partial<Delegate>) => {
      const saved = { ...v, id: `new-${delegates.length}` } as Row;
      delegates.push(saved);
      return Promise.resolve(saved);
    }),
  };
  const admissionRepo = {
    count: jest.fn().mockResolvedValue(opts.admitted ?? 0),
  };
  const repos = new Map<unknown, unknown>([
    [Ticket, ticketRepo],
    [Delegate, delegateRepo],
    [TicketAdmission, admissionRepo],
  ]);
  const query = jest.fn().mockResolvedValue(undefined);
  const manager = { getRepository: (e: unknown) => repos.get(e), query };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
    getRepository: (e: unknown) => repos.get(e),
  } as unknown as DataSource;
  const editions = {
    findById: jest.fn().mockResolvedValue({
      id: 'e1',
      name: 'GS-27 Summit',
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: opts.endsAt ?? FUTURE,
    }),
    card: jest.fn().mockResolvedValue({ id: 'e1', name: 'GS-27 Summit' }),
  } as unknown as EditionsService;
  const email = { send: jest.fn().mockResolvedValue(undefined) };
  const service = new TicketTransferService(dataSource, editions, email);
  return {
    service,
    tickets,
    delegates,
    email,
    query,
    ticketRepo,
    ticket: tickets[0],
  };
}

/** The [to, subject, text] of the email sent to `to`. */
const sentTo = (email: { send: jest.Mock }, to: string) =>
  (email.send.mock.calls as [string, string, string][]).find(
    (c) => c[0] === to,
  )!;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deleted = (query: jest.Mock) =>
  query.mock.calls
    .filter((c: [string]) => c[0].startsWith('DELETE FROM delegates'))
    .map((c: [string, string[]]) => c[1][0]);

describe('TicketTransferService.transfer', () => {
  it('moves the ticket to an existing account and voids the old QR', async () => {
    const { service, ticket, ticketRepo } = setup();
    await service.transfer(TICKET_ID, 'ada', {
      name: ' Tunde Bakare ',
      email: 'Tunde@NESG.org ',
    });
    expect(ticket).toMatchObject({
      delegateId: 'tunde',
      purchasedBy: 'ada',
      guestName: 'Tunde Bakare',
      guestEmail: 'tunde@nesg.org',
      qrVersion: 1,
    });
    expect(ticketRepo.findOne).toHaveBeenCalledWith({
      where: { id: TICKET_ID },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('creates an unclaimed account for someone new, and emails them how to sign up', async () => {
    const { service, delegates, email, ticket } = setup();
    await service.transfer(TICKET_ID, 'ada', {
      name: 'Bola Ade',
      email: 'bola@example.net',
    });
    await flush();
    const bola = delegates.find((d) => d.email === 'bola@example.net');
    expect(bola).toMatchObject({
      name: 'Bola Ade',
      tags: ['ticket-holder'],
      hasChosenPassword: false,
      consentAt: null,
      passwordHash: 'placeholder-hash',
    });
    expect(ticket.delegateId).toBe(bola!.id);
    const toBola = sentTo(email, 'bola@example.net');
    expect(toBola[1]).toBe('Your ticket to GS-27 Summit');
    expect(toBola[2]).toContain('Ada Okafor has got you a Standard ticket');
    expect(toBola[2]).toContain('sign up with this email');
  });

  it('removes the previous holder’s unclaimed account once it holds nothing, and tells them', async () => {
    const { service, query, email } = setup();
    await service.transfer(TICKET_ID, 'ada', {
      name: 'Tunde Bakare',
      email: 'tunde@nesg.org',
    });
    await flush();
    expect(deleted(query)).toEqual(['grace']);
    const toGrace = sentTo(email, 'grace@example.org');
    expect(toGrace[2]).toContain('no longer admits anyone');
    expect(toGrace[2]).toContain('has been removed');
  });

  it('never removes an account the previous holder has set up', async () => {
    const { service, query } = setup({
      ticket: { delegateId: 'tunde', guestEmail: 'tunde@nesg.org' },
    });
    await service.transfer(TICKET_ID, 'ada', {
      name: 'Grace Obi',
      email: 'grace@example.org',
    });
    expect(deleted(query)).toEqual([]);
  });

  it('keeps an unclaimed account that still holds another ticket', async () => {
    const base = setup().tickets[0];
    const { service, query } = setup({
      tickets: [
        base,
        { ...base, id: 'other', editionId: 'e2', purchasedBy: 'someone' },
      ],
    });
    await service.transfer(TICKET_ID, 'ada', {
      name: 'Tunde Bakare',
      email: 'tunde@nesg.org',
    });
    expect(deleted(query)).toEqual([]);
  });

  it('lets the buyer take it themselves, without emailing them', async () => {
    const { service, ticket, email } = setup();
    await service.transfer(TICKET_ID, 'ada', {
      name: 'Ada Okafor',
      email: 'ada@example.com',
    });
    await flush();
    expect(ticket).toMatchObject({ delegateId: 'ada', purchasedBy: 'ada' });
    expect(
      email.send.mock.calls.some((c: string[]) => c[0] === 'ada@example.com'),
    ).toBe(false);
  });

  describe('refuses', () => {
    const to = { name: 'Tunde Bakare', email: 'tunde@nesg.org' };

    it('anyone but the buyer', async () => {
      const { service, ticket } = setup();
      await expect(service.transfer(TICKET_ID, 'grace', to)).rejects.toThrow(
        ForbiddenException,
      );
      expect(ticket.delegateId).toBe('grace');
    });

    it('a ticket the buyer bought for themselves', async () => {
      const { service } = setup({
        ticket: { delegateId: 'ada', purchasedBy: null },
      });
      await expect(service.transfer(TICKET_ID, 'ada', to)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('once someone has been admitted on it', async () => {
      const { service, ticket } = setup({ admitted: 1 });
      await expect(service.transfer(TICKET_ID, 'ada', to)).rejects.toThrow(
        /already been admitted/,
      );
      expect(ticket.qrVersion).toBe(0);
    });

    it('after the event has ended', async () => {
      const { service } = setup({ endsAt: new Date(Date.now() - 3_600_000) });
      await expect(service.transfer(TICKET_ID, 'ada', to)).rejects.toThrow(
        /GS-27 Summit has ended/,
      );
    });

    it('the person it is already for', async () => {
      const { service } = setup();
      await expect(
        service.transfer(TICKET_ID, 'ada', {
          name: 'Grace',
          email: 'GRACE@example.org',
        }),
      ).rejects.toThrow(
        new BadRequestException('This ticket is already for grace@example.org'),
      );
    });

    it('someone who already holds a ticket to the event', async () => {
      const base = setup().tickets[0];
      const { service } = setup({
        tickets: [
          base,
          { ...base, id: 'tunde-own', delegateId: 'tunde', purchasedBy: null },
        ],
      });
      await expect(service.transfer(TICKET_ID, 'ada', to)).rejects.toThrow(
        /already has a ticket to GS-27 Summit/,
      );
    });

    it('a ticket that does not exist', async () => {
      const { service } = setup({ tickets: [] });
      await expect(service.transfer(TICKET_ID, 'ada', to)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
