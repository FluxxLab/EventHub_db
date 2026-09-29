import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { DataSource, Repository } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import type { Booth } from '../passport/entities/booth.entity';
import type { AdmissionService } from '../ticketing/admission.service';
import type { BoothLeadKey } from './entities/booth-lead-key.entity';
import type { BoothLead } from './entities/booth-lead.entity';
import { LeadsService } from './leads.service';

/**
 * Lead capture: a stand's link works until it is replaced or revoked, only
 * a genuine badge for this event records a lead, a second scan finds the
 * same lead, and a stand only ever touches its own leads.
 */
const BOOTH = '11111111-1111-4111-8111-111111111111';
const EDITION = '22222222-2222-4222-8222-222222222222';
const booth = {
  id: BOOTH,
  editionId: EDITION,
  name: 'Kora Health',
  location: 'Hall B',
} as Booth;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup(
  opts: {
    keyHash?: string | null;
    ticket?: object | null;
    inserted?: boolean;
    lead?: object | null;
  } = {},
) {
  const saved: object[] = [];
  const keys = {
    findOneBy: jest
      .fn()
      .mockResolvedValue(
        opts.keyHash === null
          ? null
          : { boothId: BOOTH, keyHash: opts.keyHash ?? sha('secret') },
      ),
    save: jest.fn((k: object) => {
      saved.push(k);
      return Promise.resolve(k);
    }),
    delete: jest.fn(),
  } as unknown as Repository<BoothLeadKey>;
  const qb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      raw: opts.inserted === false ? [] : [{ id: 'l1' }],
    }),
  };
  const saveLead = jest.fn((l: object) => Promise.resolve(l));
  const leads = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOneBy: jest
      .fn()
      .mockResolvedValue(
        opts.lead === undefined
          ? { id: 'l1', boothId: BOOTH, note: null, rating: null }
          : opts.lead,
      ),
    save: saveLead,
    delete: jest.fn(),
  } as unknown as Repository<BoothLead>;
  const view = {
    id: 'l1',
    boothId: BOOTH,
    name: 'Ada Okafor',
    email: 'ada@x.org',
  };
  const ticket =
    opts.ticket === undefined
      ? { id: 't1', editionId: EDITION, delegateId: 'd1' }
      : opts.ticket;
  const dataSource = {
    getRepository: jest.fn().mockReturnValue({
      findOneBy: jest.fn(({ id }: { id: string }) =>
        Promise.resolve(id === BOOTH ? booth : ticket),
      ),
    }),
    query: jest.fn().mockResolvedValue([view]),
  } as unknown as DataSource;
  const editions = {
    card: jest.fn().mockResolvedValue({
      id: EDITION,
      name: 'GS-27 Summit',
      shortName: 'GS-27',
    }),
  } as unknown as EditionsService;
  const admission = {
    verify: jest.fn((qr: string) => (qr === 'PICT1.good.sig' ? 't1' : null)),
  } as unknown as AdmissionService;
  return {
    service: new LeadsService(leads, keys, dataSource, editions, admission),
    saved,
    qb,
    saveLead,
  };
}

describe('LeadsService', () => {
  it('hands out a link whose secret is kept only as a hash', async () => {
    const { service, saved } = setup();
    const { key } = await service.issueKey(BOOTH, 'staff');
    const [boothId, secret] = key.split('.');
    expect(boothId).toBe(BOOTH);
    expect(saved[0]).toEqual({
      boothId: BOOTH,
      keyHash: sha(secret),
      createdBy: 'staff',
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  it('opens the stand for its key, and refuses wrong, revoked and malformed keys alike', async () => {
    await expect(setup().service.boothForKey(`${BOOTH}.secret`)).resolves.toBe(
      booth,
    );
    for (const [key, keyHash] of [
      [`${BOOTH}.wrong`, undefined],
      [`${BOOTH}.secret`, null],
      ['not-a-key', undefined],
      [undefined, undefined],
    ] as const) {
      await expect(
        setup({ keyHash }).service.boothForKey(key),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('records a genuine badge once; a second scan finds the same lead', async () => {
    const first = await setup().service.scan(booth, 'PICT1.good.sig');
    expect(first).toMatchObject({ isNew: true, lead: { name: 'Ada Okafor' } });
    const again = setup({ inserted: false });
    await expect(
      again.service.scan(booth, 'PICT1.good.sig'),
    ).resolves.toMatchObject({ isNew: false });
    expect(again.qb.values).toHaveBeenCalledWith({
      boothId: BOOTH,
      editionId: EDITION,
      delegateId: 'd1',
      ticketId: 't1',
    });
  });

  it('refuses a forged QR and a badge for another event', async () => {
    await expect(
      setup().service.scan(booth, 'PICT1.forged.sig'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({
        ticket: { id: 't1', editionId: 'other', delegateId: 'd1' },
      }).service.scan(booth, 'PICT1.good.sig'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("notes and rates the stand's own leads only", async () => {
    const { service, saveLead } = setup();
    await service.update(booth, '33333333-3333-4333-8333-333333333333', {
      note: '  Wants a demo ',
      rating: 'hot',
    });
    expect(saveLead).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Wants a demo', rating: 'hot' }),
    );
    await expect(
      setup({ lead: null }).service.update(
        booth,
        '33333333-3333-4333-8333-333333333333',
        { rating: 'warm' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup().service.remove(booth, 'not-an-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
