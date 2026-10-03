import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { IssueService } from './issue.service';

/**
 * Moving a ticket to another tier of its event, from the delegates list: the
 * tiers' counts follow it, the new tier must have room, and another event's
 * tier is refused.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';
const STANDARD = '33333333-3333-4333-8333-333333333331';
const VIP = '33333333-3333-4333-8333-333333333332';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TICKET = '44444444-4444-4444-8444-444444444444';

function setup(
  opts: { capacity?: number | null; sold?: number; ticket?: boolean } = {},
) {
  const types: Record<string, Partial<TicketType>> = {
    [STANDARD]: {
      id: STANDARD,
      editionId: EDITION,
      name: 'Standard',
      section: 'General',
      capacity: null,
      sold: 10,
    },
    [VIP]: {
      id: VIP,
      editionId: EDITION,
      name: 'VIP',
      section: 'VIP',
      capacity: opts.capacity ?? null,
      sold: opts.sold ?? 3,
    },
    [OTHER]: {
      id: OTHER,
      editionId: 'another-edition',
      name: 'VIP',
      section: 'VIP',
      capacity: null,
      sold: 0,
    },
  };
  const ticket = {
    id: TICKET,
    editionId: EDITION,
    ticketTypeId: STANDARD,
    tierName: 'Standard',
    section: 'General',
    quantity: 2,
  };
  const updates: { entity: unknown; id: string; values: Partial<Ticket> }[] =
    [];
  const manager = {
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === Ticket && opts.ticket !== false ? { ...ticket } : null,
      ),
    ),
    find: jest.fn((_: unknown, q: { where: { id: { _value: string[] } } }) =>
      Promise.resolve(q.where.id._value.map((id) => types[id]).filter(Boolean)),
    ),
    save: jest.fn((row: Partial<TicketType>) => {
      types[row.id!] = row;
      return Promise.resolve(row);
    }),
    update: jest.fn((entity: unknown, id: string, values: Partial<Ticket>) => {
      updates.push({ entity, id, values });
      return Promise.resolve({});
    }),
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  } as unknown as DataSource;
  const service = new IssueService(
    dataSource,
    {} as EditionsService,
    {} as EmailSender,
  );
  return { service, types, updates };
}

describe('moving a ticket to another tier', () => {
  it('moves it, and its seats from one count to the other', async () => {
    const { service, types, updates } = setup();
    await expect(service.changeTier(TICKET, VIP)).resolves.toEqual({
      ticketId: TICKET,
      ticketTypeId: VIP,
      tierName: 'VIP',
      section: 'VIP',
    });
    expect(types[STANDARD].sold).toBe(8);
    expect(types[VIP].sold).toBe(5);
    expect(updates).toEqual([
      {
        entity: Ticket,
        id: TICKET,
        values: { ticketTypeId: VIP, tierName: 'VIP', section: 'VIP' },
      },
    ]);
  });

  it('changes nothing when it is already in that tier', async () => {
    const { service, updates } = setup();
    await expect(service.changeTier(TICKET, STANDARD)).resolves.toMatchObject({
      ticketTypeId: STANDARD,
    });
    expect(updates).toEqual([]);
  });

  it('refuses a full tier, naming it', async () => {
    const { service, updates } = setup({ capacity: 4, sold: 3 });
    await expect(service.changeTier(TICKET, VIP)).rejects.toThrow(
      ConflictException,
    );
    await expect(service.changeTier(TICKET, VIP)).rejects.toThrow(
      'VIP is full: 3 of 4 taken',
    );
    expect(updates).toEqual([]);
  });

  it("refuses another event's tier", async () => {
    const { service } = setup();
    await expect(service.changeTier(TICKET, OTHER)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('says when the ticket does not exist', async () => {
    const { service } = setup({ ticket: false });
    await expect(service.changeTier(TICKET, VIP)).rejects.toThrow(
      NotFoundException,
    );
  });
});
