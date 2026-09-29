import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService } from './delegates.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { Delegate } from './entities/delegate.entity';

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));

/** What the global ValidationPipe does to a PATCH /delegates/me body. */
async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateMeDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors: errors.map((e) => e.property) };
}

describe('UpdateMeDto profile fields', () => {
  it('trims the name and holds it to 2..100 characters', async () => {
    await expect(check({ name: '  Ada Obi  ' })).resolves.toMatchObject({
      dto: { name: 'Ada Obi' },
      errors: [],
    });
    expect((await check({ name: ' A ' })).errors).toEqual(['name']);
    expect((await check({ name: 'x'.repeat(101) })).errors).toEqual(['name']);
  });

  it('normalises the phone the way registration does, and lets empty clear it', async () => {
    await expect(check({ phone: '0801 234 5678' })).resolves.toMatchObject({
      dto: { phone: '+2348012345678' },
      errors: [],
    });
    await expect(check({ phone: '   ' })).resolves.toMatchObject({
      dto: { phone: '' },
      errors: [],
    });
    expect((await check({ phone: 'call me' })).errors).toEqual(['phone']);
  });

  it('takes a known gender or null, nothing else', async () => {
    expect((await check({ gender: 'non-binary' })).errors).toEqual([]);
    expect((await check({ gender: null })).errors).toEqual([]);
    expect((await check({ gender: 'other' })).errors).toEqual(['gender']);
  });

  it('takes directoryVisible as a boolean only', async () => {
    expect((await check({ directoryVisible: false })).errors).toEqual([]);
    expect((await check({ directoryVisible: 'no' })).errors).toEqual([
      'directoryVisible',
    ]);
  });
});

function build(current: Partial<Delegate> = {}) {
  const wheres: { sql: string; params?: Record<string, unknown> }[] = [];
  const qb: Record<string, jest.Mock> = {};
  for (const key of ['where', 'andWhere'] as const) {
    qb[key] = jest.fn((sql: string, params?: Record<string, unknown>) => {
      wheres.push({ sql, params });
      return qb;
    });
  }
  for (const key of ['orderBy', 'limit', 'offset', 'take'] as const) {
    qb[key] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getMany = jest.fn().mockResolvedValue([]);

  const row = {
    id: 'd1',
    name: 'Ada Obi',
    phone: '+2348012345678',
    gender: null,
    directoryVisible: true,
    avatarUrl: null,
    ...current,
  } as Delegate;
  const delegateRepository = {
    createQueryBuilder: jest.fn(() => qb),
    findOneBy: jest.fn().mockResolvedValue(row),
    save: jest.fn((d: Delegate) => Promise.resolve({ ...d })),
  };
  const storage = { resolveAvatar: jest.fn().mockResolvedValue(null) };
  const catalog = { assertInterests: jest.fn().mockResolvedValue(undefined) };
  const unused = {};
  const service = new DelegatesService(
    delegateRepository as unknown as Repository<Delegate>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as Repository<never>,
    unused as RealtimeService,
    storage as unknown as StorageService,
    unused as Queue,
    unused as DataSource,
    catalog as unknown as CatalogService,
  );
  const find = (needle: string) => wheres.find((w) => w.sql.includes(needle));
  return { service, delegateRepository, find, catalog };
}

describe('DelegatesService.updateProfile profile fields', () => {
  it('saves name, phone, gender and visibility, and returns them', async () => {
    const { service, delegateRepository } = build();
    const view = await service.updateProfile('d1', {
      name: 'Ada N. Obi',
      phone: '+2349030000000',
      gender: 'female',
      directoryVisible: false,
    });
    expect(delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ada N. Obi',
        phone: '+2349030000000',
        gender: 'female',
        directoryVisible: false,
      }),
    );
    expect(view).toMatchObject({
      name: 'Ada N. Obi',
      gender: 'female',
      directoryVisible: false,
    });
  });

  it('clears the phone on an empty string and the gender on null', async () => {
    const { service, delegateRepository } = build({ gender: 'male' });
    await service.updateProfile('d1', { phone: '', gender: null });
    expect(delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ phone: null, gender: null }),
    );
  });

  it('leaves fields the body did not mention alone', async () => {
    const { service, delegateRepository } = build({
      gender: 'undisclosed',
      directoryVisible: false,
    });
    await service.updateProfile('d1', { title: 'CTO' });
    expect(delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ada Obi',
        phone: '+2348012345678',
        gender: 'undisclosed',
        directoryVisible: false,
      }),
    );
  });
});

describe('DelegatesService.updateProfile interests', () => {
  it('checks new interests against the catalog, passing what is already saved', async () => {
    const { service, catalog, delegateRepository } = build({
      interests: ['Retired'],
    });
    await service.updateProfile('d1', { interests: ['Retired', 'Policy'] });
    expect(catalog.assertInterests).toHaveBeenCalledWith(
      ['Retired', 'Policy'],
      ['Retired'],
    );
    expect(delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ interests: ['Retired', 'Policy'] }),
    );
  });

  it('saves nothing when the catalog refuses an interest', async () => {
    const { service, catalog, delegateRepository } = build();
    catalog.assertInterests.mockRejectedValue(
      new BadRequestException('Unknown interest: Astrology'),
    );
    await expect(
      service.updateProfile('d1', { interests: ['Astrology'] }),
    ).rejects.toThrow('Unknown interest: Astrology');
    expect(delegateRepository.save).not.toHaveBeenCalled();
  });

  it('does not consult the catalog when interests are not sent', async () => {
    const { service, catalog } = build();
    await service.updateProfile('d1', { name: 'Ada Obi' });
    expect(catalog.assertInterests).not.toHaveBeenCalled();
  });
});

describe('directoryVisible = false hides a delegate', () => {
  it('from the directory', async () => {
    const { service, find } = build();
    await service.listDelegatesPublic({});
    expect(find('directoryVisible')?.sql).toBe('d.directoryVisible = true');
  });

  it('from search', async () => {
    const { service, find } = build();
    await service.searchDelegates('ada', 10);
    expect(find('directoryVisible')?.sql).toBe('d.directoryVisible = true');
  });

  it('from an edition’s attendees, except from themselves', async () => {
    const { service, find } = build();
    await service.listEditionAttendees('e1', 'me', {});
    expect(find('directoryVisible')).toEqual({
      sql: '(d.directoryVisible = true OR d.id = :me)',
      params: { me: 'me' },
    });
  });
});
