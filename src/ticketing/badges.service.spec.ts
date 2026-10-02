import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { EditionsService } from '../editions/editions.service';
import type { AdmissionService } from './admission.service';
import type { StorageService } from '../common/storage/storage.service';
import { BadgesService } from './badges.service';

/**
 * Badges: the QR printed on a badge is the ticket's own signed door payload,
 * the account's name wins over the checkout name, and the design is kept
 * tidy (one colour per tier, lower-case hex).
 */
const EDITION_ID = '22222222-2222-4222-8222-222222222222';

function setup(
  opts: { rows?: Record<string, unknown>[]; missing?: boolean } = {},
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
    getRawMany: jest.fn().mockResolvedValue(opts.rows ?? []),
  };
  const repo = {
    findOne: jest.fn().mockResolvedValue({ id: EDITION_ID, badgeDesign: null }),
    update: jest.fn().mockResolvedValue({}),
  };
  const dataSource = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    getRepository: jest.fn().mockReturnValue(repo),
  } as unknown as DataSource;
  const editions = {
    findById: jest
      .fn()
      .mockImplementation(() =>
        opts.missing
          ? Promise.reject(new NotFoundException('Edition not found'))
          : Promise.resolve({ id: EDITION_ID, name: 'GS-27' }),
      ),
  } as unknown as EditionsService;
  const storage = {
    resolveAvatar: jest.fn((key: string | null) =>
      Promise.resolve(key ? `https://signed/${key}` : null),
    ),
    presignRead: jest.fn((key: string) =>
      Promise.resolve(`https://signed/${key}`),
    ),
  } as unknown as StorageService;
  const admission = {
    qrFor: jest.fn((id: string) => `PICT1.${id}.sig`),
  } as unknown as AdmissionService;
  return {
    service: new BadgesService(dataSource, editions, admission, storage),
    qb,
    repo,
  };
}

describe('BadgesService', () => {
  it('prints the signed door QR and numbers from the database as numbers', async () => {
    const { service } = setup({
      rows: [
        {
          ticketId: 't1',
          code: 'PIC-VIP-AB12',
          name: 'Ada Okafor',
          title: 'Director',
          organisation: 'PIC',
          country: 'Nigeria',
          avatarUrl: 'avatars/ada.jpg',
          tierName: 'VIP',
          ticketTypeId: 'tt1',
          section: 'Front',
          quantity: 1,
          admitted: '1',
        },
      ],
    });
    const [badge] = await service.holders(EDITION_ID);
    expect(badge).toMatchObject({
      qr: 'PICT1.t1.sig',
      photo: 'https://signed/avatars/ada.jpg',
      admitted: 1,
      quantity: 1,
      name: 'Ada Okafor',
    });
  });

  it('filters by tier only when asked', async () => {
    const a = setup();
    await a.service.holders(EDITION_ID);
    expect(a.qb.andWhere).not.toHaveBeenCalled();
    const b = setup();
    await b.service.holders(EDITION_ID, 'tt1');
    expect(b.qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ticketTypeId'),
      { ticketTypeId: 'tt1' },
    );
  });

  it('refuses an edition that does not exist', async () => {
    const { service } = setup({ missing: true });
    await expect(service.holders(EDITION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.design(EDITION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('keeps one colour per tier and lower-case hex', async () => {
    const { service, repo } = setup();
    const saved = await service.saveDesign(EDITION_ID, {
      size: 'a6',
      accent: '#002D74',
      fields: ['organisation', 'qr'],
      tierColours: [
        { tier: 'VIP ', colour: '#AA0000' },
        { tier: 'VIP', colour: '#B8860B' },
      ],
    });
    const stored = {
      size: 'a6',
      accent: '#002d74',
      fields: ['organisation', 'qr'],
      tierColours: [{ tier: 'VIP', colour: '#b8860b' }],
      artwork: null,
      layout: null,
    };
    expect(saved).toEqual({ ...stored, artworkUrl: null });
    expect(repo.update).toHaveBeenCalledWith(
      { id: EDITION_ID },
      { badgeDesign: stored },
    );
  });

  it('keeps artwork with where the parts go, and links to it when read', async () => {
    const { service } = setup();
    const layout = {
      photo: { x: 0.5, y: 0.3, scale: 1 },
      who: { x: 0.5, y: 0.55, scale: 1.2 },
      scan: { x: 0.5, y: 0.8, scale: 0.8 },
    };
    const key = 'badges/0b8f7d1e-4a3c-4e4f-9a51-6c2d9e1f0a11';
    const base = {
      size: 'a6' as const,
      accent: '#002d74',
      fields: [],
      tierColours: [],
    };
    await expect(
      service.saveDesign(EDITION_ID, { ...base, artwork: key }),
    ).rejects.toThrow('Say where the photo, name and QR go');
    const saved = await service.saveDesign(EDITION_ID, {
      ...base,
      artwork: key,
      layout,
    });
    expect(saved).toMatchObject({
      artwork: key,
      layout,
      artworkUrl: `https://signed/${key}`,
    });
    // no artwork: no layout kept either
    const plain = await service.saveDesign(EDITION_ID, { ...base, layout });
    expect(plain.layout).toBeNull();
  });
});
