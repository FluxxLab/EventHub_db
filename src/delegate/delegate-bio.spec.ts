import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import type { RealtimeService } from '../common/realtime/realtime.service';
import type { StorageService } from '../common/storage/storage.service';
import type { CatalogService } from '../catalog/catalog.service';
import { DelegatesService } from './delegates.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { BIO_MAX, Delegate } from './entities/delegate.entity';

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

describe('UpdateMeDto bio', () => {
  it('trims it and holds it to BIO_MAX characters', async () => {
    await expect(check({ bio: '  Policy nerd.  ' })).resolves.toMatchObject({
      dto: { bio: 'Policy nerd.' },
      errors: [],
    });
    // the limit applies after trimming
    expect((await check({ bio: `  ${'x'.repeat(BIO_MAX)}  ` })).errors).toEqual(
      [],
    );
    expect((await check({ bio: 'x'.repeat(BIO_MAX + 1) })).errors).toEqual([
      'bio',
    ]);
    expect((await check({ bio: 42 })).errors).toEqual(['bio']);
  });
});

function build(current: Partial<Delegate> = {}) {
  const row = {
    id: 'd1',
    name: 'Ada Obi',
    accessTier: 'standard',
    directoryVisible: true,
    flagged: false,
    pendingReview: false,
    avatarUrl: null,
    bio: null,
    tags: [],
    tracks: [],
    ...current,
  } as unknown as Delegate;
  const delegateRepository = {
    findOneBy: jest.fn().mockResolvedValue(row),
    save: jest.fn((d: Delegate) => Promise.resolve({ ...d })),
  };
  const storage = { resolveAvatar: jest.fn().mockResolvedValue(null) };
  const presence = { revokeAll: jest.fn() };
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
    unused as CatalogService,
    undefined,
    presence as never,
  );
  return { service, delegateRepository, presence };
}

describe('DelegatesService bio', () => {
  it('saves the bio and returns it on the profile', async () => {
    const { service, delegateRepository } = build();
    const view = await service.updateProfile('d1', { bio: 'Policy nerd.' });
    expect(delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ bio: 'Policy nerd.' }),
    );
    expect(view).toMatchObject({ bio: 'Policy nerd.' });
  });

  it('clears it on an empty string and leaves it alone when not sent', async () => {
    const cleared = build({ bio: 'Old bio' });
    await cleared.service.updateProfile('d1', { bio: '' });
    expect(cleared.delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ bio: null }),
    );

    const untouched = build({ bio: 'Old bio' });
    await untouched.service.updateProfile('d1', { name: 'Ada Obi' });
    expect(untouched.delegateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ bio: 'Old bio' }),
    );
  });

  it('shows the bio on the single profile, not in directory rows', async () => {
    const { service } = build({ bio: 'Policy nerd.' });
    await expect(
      service.findDirectoryEntry('d1', 'viewer'),
    ).resolves.toMatchObject({ id: 'd1', bio: 'Policy nerd.' });
    expect(
      DelegatesService.toDirectoryView({
        id: 'd1',
        bio: 'Policy nerd.',
      } as Delegate),
    ).not.toHaveProperty('bio');
  });

  it('hides the bio of a delegate hidden from the directory, except from themselves', async () => {
    const { service } = build({ bio: 'Private', directoryVisible: false });
    await expect(
      service.findDirectoryEntry('d1', 'viewer'),
    ).resolves.toMatchObject({ bio: null });
    await expect(service.findDirectoryEntry('d1', 'd1')).resolves.toMatchObject(
      {
        bio: 'Private',
      },
    );
  });

  it('going hidden withdraws presence watchers; staying visible does not', async () => {
    const hiding = build();
    await hiding.service.updateProfile('d1', { directoryVisible: false });
    expect(hiding.presence.revokeAll).toHaveBeenCalledWith('d1');

    const already = build({ directoryVisible: false });
    await already.service.updateProfile('d1', { directoryVisible: false });
    expect(already.presence.revokeAll).not.toHaveBeenCalled();

    const visible = build();
    await visible.service.updateProfile('d1', { bio: 'hi' });
    expect(visible.presence.revokeAll).not.toHaveBeenCalled();
  });
});
