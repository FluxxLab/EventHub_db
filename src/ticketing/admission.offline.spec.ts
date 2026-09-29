import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import { AdmissionService, qrDigest } from './admission.service';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { Ticket } from './entities/ticket.entity';

/**
 * Offline gate: a phone without signal checks scans against a downloaded
 * manifest and uploads its admissions later. What matters: the manifest never
 * carries anything a QR can be rebuilt from, a transferred ticket's old QR
 * does not match it, an upload admits at the scan time, re-sending it admits
 * nobody twice, and every conflict comes back named instead of thrown.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';
const OTHER_EDITION = '33333333-3333-4333-8333-333333333333';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '11111111-1111-4111-8111-111111111112';
const T3 = '11111111-1111-4111-8111-111111111113';
const uuid = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: T1,
  orderId: 'o1',
  delegateId: 'd1',
  purchasedBy: null,
  editionId: EDITION,
  ticketTypeId: 'tt1',
  tierName: 'Standard',
  quantity: 1,
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
    tickets?: Ticket[];
    manifestRows?: Record<string, unknown>[];
    raceOnInsert?: boolean;
  } = {},
) {
  const rows = new Map((opts.tickets ?? [ticket()]).map((t) => [t.id, t]));
  const admitted: Partial<TicketAdmission>[] = [];

  const manifestQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.manifestRows ?? []),
  };
  const tx = {
    findOne: jest.fn((_e: unknown, { where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    ),
    count: jest.fn((_e: unknown, { where }: { where: { ticketId: string } }) =>
      Promise.resolve(
        admitted.filter((a) => a.ticketId === where.ticketId).length,
      ),
    ),
    insert: jest.fn((_e: unknown, v: Partial<TicketAdmission>) => {
      if (opts.raceOnInsert) {
        // the other copy of this upload committed first
        admitted.push(v);
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      admitted.push(v);
      return Promise.resolve({});
    }),
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof tx) => unknown) => fn(tx)),
    createQueryBuilder: jest.fn().mockReturnValue(manifestQuery),
  } as unknown as DataSource;

  // usage(): counts per ticket, the way the grouped query returns them
  let usageIds: string[] = [];
  const usageQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn((_sql: string, p: { ids: string[] }): unknown => {
      usageIds = p.ids;
      return usageQuery;
    }),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(() =>
      Promise.resolve(
        usageIds
          .map((id) => {
            const mine = admitted.filter((a) => a.ticketId === id);
            return mine.length
              ? {
                  ticketId: id,
                  admitted: mine.length,
                  lastAdmittedAt: mine[mine.length - 1].admittedAt,
                }
              : null;
          })
          .filter(Boolean),
      ),
    ),
    // summary()
    getRawOne: jest.fn().mockResolvedValue({ admitted: 0, ticketsUsed: 0 }),
  };
  const admissions = {
    findOne: jest.fn(({ where }: { where: { clientId: string } }) =>
      Promise.resolve(
        admitted.find((a) => a.clientId === where.clientId) ?? null,
      ),
    ),
    createQueryBuilder: jest.fn().mockReturnValue(usageQuery),
  } as unknown as Repository<TicketAdmission>;
  const tickets = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    ),
    count: jest.fn().mockResolvedValue(rows.size),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue({ tickets: rows.size, places: rows.size }),
    }),
  } as unknown as Repository<Ticket>;
  const editions = {
    card: jest.fn((id: string) =>
      Promise.resolve({
        id,
        name: id === EDITION ? 'GS-27 Summit' : 'Policy Workshop',
      }),
    ),
  } as unknown as EditionsService;
  const config = {
    get: jest.fn().mockReturnValue('ticket-secret'),
    getOrThrow: jest.fn().mockReturnValue('jwt-secret'),
  } as unknown as ConfigService;
  const service = new AdmissionService(
    tickets,
    admissions,
    dataSource,
    editions,
    config,
  );
  return { service, admitted, tx, manifestQuery };
}

const scan = (qr: string, n: number, at = '2026-09-07T08:00:00Z') => ({
  qr,
  scannedAt: new Date(at),
  clientId: uuid(n),
  deviceId: 'gate-phone-1',
});

describe('AdmissionService offline manifest', () => {
  const row = (id: string, qrVersion = 0) => ({
    id,
    code: `PIC-${id.slice(-4)}`,
    name: 'Ada Okafor',
    tierName: 'VIP',
    section: 'General',
    quantity: '1',
    qrVersion,
    admitted: '0',
  });

  it("carries a digest of each ticket's current QR, never the signature", async () => {
    const { service } = setup({ manifestRows: [row(T1), row(T2, 2)] });
    const manifest = await service.manifest(EDITION);

    const current1 = service.qrFor(T1, 0);
    const current2 = service.qrFor(T2, 2);
    expect(manifest.tickets.map((t) => t.digest)).toEqual([
      qrDigest(current1),
      qrDigest(current2),
    ]);
    const json = JSON.stringify(manifest);
    for (const qr of [
      current1,
      current2,
      service.qrFor(T2, 0),
      service.qrFor(T2, 1),
    ]) {
      expect(json).not.toContain(qr.split('.')[2]);
    }
    expect(manifest).toMatchObject({
      format: 1,
      editionId: EDITION,
      editionName: 'GS-27 Summit',
      total: 1,
      nextCursor: null,
    });
    expect(manifest.tickets[0]).toMatchObject({
      quantity: 1,
      admitted: 0,
      tierName: 'VIP',
    });
  });

  it("lists a transferred ticket's earlier QRs as revoked, not as valid", async () => {
    const { service } = setup({ manifestRows: [row(T2, 2)] });
    const manifest = await service.manifest(EDITION);
    const old = [
      qrDigest(service.qrFor(T2, 0)),
      qrDigest(service.qrFor(T2, 1)),
    ];
    expect(manifest.revoked).toEqual(old);
    expect(manifest.tickets.map((t) => t.digest)).not.toEqual(
      expect.arrayContaining(old),
    );
  });

  it('pages on the ticket id', async () => {
    const { service, manifestQuery } = setup({
      manifestRows: [row(T1), row(T2), row(T3)],
    });
    const first = await service.manifest(EDITION, undefined, 2);
    expect(first.tickets.map((t) => t.id)).toEqual([T1, T2]);
    expect(first.nextCursor).toBe(T2);
    expect(manifestQuery.limit).toHaveBeenCalledWith(3);

    await service.manifest(EDITION, T2, 2);
    expect(manifestQuery.andWhere).toHaveBeenCalledWith('t.id > :cursor', {
      cursor: T2,
    });
  });
});

describe('AdmissionService.admitBatch', () => {
  it('admits at the scan time and records the phone and the upload', async () => {
    const { service, admitted } = setup();
    const { results } = await service.admitBatch(
      [scan(service.qrFor(T1), 1, '2026-09-07T08:15:00Z')],
      'staff-1',
      EDITION,
    );
    expect(results[0]).toMatchObject({
      clientId: uuid(1),
      status: 'admitted',
      ticketId: T1,
      guestName: 'Ada Okafor',
      admitted: 1,
      quantity: 1,
    });
    expect(admitted[0]).toMatchObject({
      ticketId: T1,
      editionId: EDITION,
      scannedBy: 'staff-1',
      admittedAt: new Date('2026-09-07T08:15:00Z'),
      clientId: uuid(1),
      deviceId: 'gate-phone-1',
    });
    expect(admitted[0].syncedAt).toBeInstanceOf(Date);
  });

  it('admits nobody twice when the same upload is sent again', async () => {
    const { service, admitted } = setup();
    const item = scan(service.qrFor(T1), 1);
    await service.admitBatch([item], 'staff-1', EDITION);
    const { results } = await service.admitBatch([item], 'staff-1', EDITION);
    expect(results[0]).toMatchObject({ status: 'duplicate', ticketId: T1 });
    expect(admitted).toHaveLength(1);
  });

  it('reports two copies of one upload racing as a duplicate', async () => {
    const { service } = setup({ raceOnInsert: true });
    const { results } = await service.admitBatch(
      [scan(service.qrFor(T1), 1)],
      'staff-1',
      EDITION,
    );
    expect(results[0].status).toBe('duplicate');
  });

  it('flags a ticket whose places were used elsewhere first, without over-admitting', async () => {
    const { service, admitted } = setup();
    const qr = service.qrFor(T1);
    // two phones scanned the same single-entry ticket offline
    const { results } = await service.admitBatch(
      [
        scan(qr, 2, '2026-09-07T08:20:00Z'),
        scan(qr, 1, '2026-09-07T08:10:00Z'),
      ],
      'staff-1',
      EDITION,
    );
    // oldest scan wins, whatever order they were sent in
    expect(results.map((r) => [r.clientId, r.status])).toEqual([
      [uuid(1), 'admitted'],
      [uuid(2), 'already_used'],
    ]);
    expect(results[1].lastAdmittedAt).toEqual(new Date('2026-09-07T08:10:00Z'));
    expect(admitted).toHaveLength(1);
  });

  it("names a previous holder's QR as transferred and admits nobody", async () => {
    const { service, admitted } = setup({
      tickets: [ticket({ qrVersion: 1 })],
    });
    const { results } = await service.admitBatch(
      [
        scan(service.qrFor(T1, 0), 1),
        scan(service.qrFor(T1, 1), 2, '2026-09-07T08:01:00Z'),
      ],
      'staff-1',
      EDITION,
    );
    expect(results[0]).toMatchObject({ status: 'transferred', ticketId: T1 });
    expect(results[1].status).toBe('admitted');
    expect(admitted).toHaveLength(1);
  });

  it('turns a forged or malformed QR away as unknown, revealing nothing', async () => {
    const { service, admitted } = setup();
    const genuine = service.qrFor(T1);
    const forged = genuine.slice(0, -1) + (genuine.endsWith('A') ? 'B' : 'A');
    const { results } = await service.admitBatch(
      [scan(forged, 1), scan('PICT1.not-a-ticket.sig', 2)],
      'staff-1',
      EDITION,
    );
    expect(results.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    expect(results[0]).toMatchObject({ ticketId: null, guestName: null });
    expect(admitted).toHaveLength(0);
  });

  it("names the other event for its ticket but keeps the holder's details back", async () => {
    const { service, admitted } = setup({
      tickets: [ticket({ editionId: OTHER_EDITION })],
    });
    const { results } = await service.admitBatch(
      [scan(service.qrFor(T1), 1)],
      'staff-1',
      EDITION,
    );
    expect(results[0]).toMatchObject({
      status: 'wrong_event',
      message: 'This ticket is for Policy Workshop',
      ticketId: null,
      guestName: null,
    });
    expect(admitted).toHaveLength(0);
  });

  it('never dates an admission in the future when a phone clock runs ahead', async () => {
    const { service, admitted } = setup();
    const before = Date.now();
    await service.admitBatch(
      [scan(service.qrFor(T1), 1, '2099-01-01T00:00:00Z')],
      'staff-1',
      EDITION,
    );
    expect((admitted[0].admittedAt as Date).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect((admitted[0].admittedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before,
    );
  });
});
