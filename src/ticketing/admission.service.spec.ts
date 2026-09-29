import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import { AdmissionService } from './admission.service';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { Ticket } from './entities/ticket.entity';

/**
 * The entrance gate lets people in on a ticket. What matters: a forged or
 * altered QR admits nobody, a ticket for N admits exactly N, a ticket for
 * another event is refused with that event named, and there is no time
 * window.
 */
const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const EDITION_ID = '22222222-2222-4222-8222-222222222222';

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: TICKET_ID,
  orderId: 'o1',
  delegateId: 'd1',
  purchasedBy: null,
  editionId: EDITION_ID,
  ticketTypeId: 'tt1',
  tierName: 'Standard',
  quantity: 2,
  code: 'PIC-STA-AB12',
  guestName: 'Ada Okafor',
  guestEmail: 'ada@example.com',
  section: 'General',
  row: 'Open',
  qrVersion: 0,
  createdAt: new Date('2027-09-01T10:00:00Z'),
  ...over,
});

function setup(
  opts: {
    row?: Ticket | null;
    used?: number;
    secret?: string;
    holder?: Record<string, unknown> | null;
    matches?: Record<string, unknown>[];
  } = {},
) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.matches ?? []),
  };
  const row = opts.row === undefined ? ticket() : opts.row;
  let used = opts.used ?? 0;
  const inserted: Partial<TicketAdmission>[] = [];
  const tx = {
    findOne: jest.fn().mockResolvedValue(row),
    count: jest.fn().mockImplementation(() => Promise.resolve(used)),
    insert: jest
      .fn()
      .mockImplementation((_e: unknown, v: Partial<TicketAdmission>) => {
        inserted.push(v);
        used += 1;
        return Promise.resolve({});
      }),
  };
  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation((fn: (m: typeof tx) => unknown) => fn(tx)),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest.fn().mockResolvedValue(
        opts.holder === undefined
          ? {
              id: 'd1',
              name: 'Ada Okafor',
              title: 'Director',
              organisation: 'PIC',
              country: 'Nigeria',
            }
          : opts.holder,
      ),
    }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as DataSource;
  const admissions = {
    find: jest.fn().mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: used }, (_, i) => ({
          admittedAt: new Date(`2027-09-07T0${8 + i}:00:00Z`),
        })),
      ),
    ),
  } as unknown as Repository<TicketAdmission>;
  const editions = {
    card: jest.fn().mockImplementation((id: string) =>
      Promise.resolve({
        id,
        name: id === EDITION_ID ? 'GS-27 Summit' : 'Policy Workshop',
      }),
    ),
  } as unknown as EditionsService;
  const config = {
    get: jest.fn().mockReturnValue(opts.secret),
    getOrThrow: jest.fn().mockReturnValue('jwt-secret'),
  } as unknown as ConfigService;
  const tickets = {
    findOne: jest.fn(() =>
      Promise.resolve(row ? { id: row.id, qrVersion: row.qrVersion } : null),
    ),
  };
  const service = new AdmissionService(
    tickets as unknown as Repository<Ticket>,
    admissions,
    dataSource,
    editions,
    config,
  );
  return { service, tx, inserted, qb };
}

describe('AdmissionService', () => {
  describe('QR signing', () => {
    it('verifies its own QR and returns the ticket id', async () => {
      const { service } = setup();
      const qr = service.qrFor(TICKET_ID);
      expect(qr.startsWith(`PICT1.${TICKET_ID}.`)).toBe(true);
      await expect(service.verify(qr)).resolves.toBe(TICKET_ID);
    });

    it('rejects a QR with one character of the signature changed', async () => {
      const { service } = setup();
      const qr = service.qrFor(TICKET_ID);
      const last = qr.slice(-1);
      await expect(
        service.verify(qr.slice(0, -1) + (last === 'A' ? 'B' : 'A')),
      ).resolves.toBeNull();
    });

    it('rejects a valid signature moved onto another ticket id', async () => {
      const { service } = setup({ row: null });
      const sig = service.qrFor(TICKET_ID).split('.')[2];
      await expect(
        service.verify(`PICT1.33333333-3333-4333-8333-333333333333.${sig}`),
      ).resolves.toBeNull();
    });

    it('rejects the printed ticket code and other shapes without throwing', async () => {
      const { service } = setup();
      for (const bad of [
        'PIC-STA-AB12',
        '',
        'PICT1..',
        `PICT1.${TICKET_ID}.short`,
        'picevents://delegates/x',
      ]) {
        await expect(service.verify(bad)).resolves.toBeNull();
      }
    });

    it('keeps version 0 signed exactly as before, so QRs already issued still verify', () => {
      const { service } = setup();
      expect(service.qrFor(TICKET_ID, 0)).toBe(service.qrFor(TICKET_ID));
      expect(service.qrFor(TICKET_ID, 1)).not.toBe(service.qrFor(TICKET_ID));
      expect(service.qrFor(TICKET_ID, 2)).not.toBe(service.qrFor(TICKET_ID, 1));
    });

    it('stops verifying the previous holder’s QR once the ticket has moved on', async () => {
      const { service } = setup({ row: ticket({ qrVersion: 1 }) });
      await expect(
        service.verify(service.qrFor(TICKET_ID)),
      ).resolves.toBeNull();
      await expect(service.verify(service.qrFor(TICKET_ID, 1))).resolves.toBe(
        TICKET_ID,
      );
    });

    it('uses TICKET_QR_SECRET when set, so rotating it voids old QRs', () => {
      const withJwt = setup().service.qrFor(TICKET_ID);
      const withOwn = setup({ secret: 'gate-secret' }).service.qrFor(TICKET_ID);
      expect(withOwn).not.toBe(withJwt);
    });
  });

  describe('admit', () => {
    it('admits and records the staff member', async () => {
      const { service, inserted } = setup();
      const result = await service.admit(service.qrFor(TICKET_ID), 'staff1');
      expect(result.status).toBe('admitted');
      expect(result.admitted).toBe(1);
      expect(result.remaining).toBe(1);
      expect(result.ticket.edition.name).toBe('GS-27 Summit');
      expect(inserted).toEqual([
        { ticketId: TICKET_ID, editionId: EDITION_ID, scannedBy: 'staff1' },
      ]);
    });

    it('admits once per place, then reports it used without recording', async () => {
      const { service, inserted } = setup({ used: 1 });
      const qr = service.qrFor(TICKET_ID);
      const second = await service.admit(qr, 'staff1');
      expect(second.status).toBe('admitted');
      expect(second.remaining).toBe(0);
      const third = await service.admit(qr, 'staff2');
      expect(third.status).toBe('already_used');
      expect(third.admitted).toBe(2);
      expect(third.firstAdmittedAt).toEqual(new Date('2027-09-07T08:00:00Z'));
      expect(inserted).toHaveLength(1);
    });

    it('locks the ticket row so two gates cannot both take the last place', async () => {
      const { service, tx } = setup();
      await service.admit(service.qrFor(TICKET_ID), 'staff1');
      expect(tx.findOne).toHaveBeenCalledWith(Ticket, {
        where: { id: TICKET_ID },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('has no time window: an event years away still admits', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2020-01-01T00:00:00Z'));
      try {
        const { service } = setup();
        await expect(
          service.admit(service.qrFor(TICKET_ID), 's'),
        ).resolves.toMatchObject({ status: 'admitted' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses a ticket for another event, naming it', async () => {
      const { service, inserted } = setup({
        row: ticket({ editionId: '44444444-4444-4444-8444-444444444444' }),
      });
      await expect(
        service.admit(service.qrFor(TICKET_ID), 's', EDITION_ID),
      ).rejects.toThrow(
        new BadRequestException('This ticket is for Policy Workshop'),
      );
      expect(inserted).toHaveLength(0);
    });

    it('404s a forged QR before touching the database', async () => {
      const { service, tx } = setup();
      await expect(
        service.admit(`PICT1.${TICKET_ID}.AAAAAAAAAAAAAAAAAAAAAA`, 's'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.findOne).not.toHaveBeenCalled();
    });

    it('refuses the previous holder’s QR after a transfer, saying so, and admits the new one', async () => {
      const { service, inserted } = setup({ row: ticket({ qrVersion: 1 }) });
      await expect(
        service.admit(service.qrFor(TICKET_ID), 's'),
      ).rejects.toThrow(
        new BadRequestException(
          'This ticket has been passed to someone else; this QR no longer admits anyone',
        ),
      );
      expect(inserted).toHaveLength(0);
      await expect(
        service.admit(service.qrFor(TICKET_ID, 1), 's'),
      ).resolves.toMatchObject({ status: 'admitted' });
    });

    it('re-checks the version under the lock, so a transfer mid-scan wins', async () => {
      // the unlocked look saw version 0; by the time the row is locked it is 1
      const { service, tx, inserted } = setup();
      tx.findOne.mockResolvedValue(ticket({ qrVersion: 1 }));
      await expect(
        service.admit(service.qrFor(TICKET_ID), 's'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inserted).toHaveLength(0);
    });

    it('404s a genuine QR whose ticket was deleted', async () => {
      const { service } = setup({ row: null });
      await expect(
        service.admit(service.qrFor(TICKET_ID), 's'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('check-in desks', () => {
    it('returns the holder as the badge shows them, and the QR to print', async () => {
      const { service } = setup();
      const result = await service.admit(service.qrFor(TICKET_ID), 'staff');
      expect(result.holder).toEqual({
        name: 'Ada Okafor',
        title: 'Director',
        organisation: 'PIC',
        country: 'Nigeria',
        photo: null,
      });
      expect(result.ticket.qr).toBe(service.qrFor(TICKET_ID));
      expect(result.ticket.ticketTypeId).toBe('tt1');
    });

    it('falls back to the name on the ticket without an account', async () => {
      const { service } = setup({ holder: null });
      const result = await service.admit(service.qrFor(TICKET_ID), 'staff');
      expect(result.holder.name).toBe('Ada Okafor');
      expect(result.holder.organisation).toBeNull();
    });

    it('finds tickets by what is said at the desk, each with its QR', async () => {
      const { service, qb } = setup({
        matches: [
          {
            ticketId: TICKET_ID,
            code: 'PIC-STA-AB12',
            name: 'Ada Okafor',
            email: 'ada@example.com',
            organisation: null,
            tierName: 'Standard',
            quantity: 2,
            admitted: '1',
            qrVersion: 2,
          },
        ],
      });
      const [match] = await service.find(EDITION_ID, ' 50%_off ');
      expect(match).toMatchObject({
        admitted: 1,
        qr: service.qrFor(TICKET_ID, 2),
      });
      expect(match).not.toHaveProperty('qrVersion');
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
        q: '50%_off',
        like: String.raw`%50\%\_off%`,
      });
      await expect(service.find(EDITION_ID, 'a')).resolves.toEqual([]);
    });
  });
});
