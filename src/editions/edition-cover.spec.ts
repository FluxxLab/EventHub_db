import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { CatalogService } from '../catalog/catalog.service';
import type { StorageService } from '../common/storage/storage.service';
import { SetEditionCoverDto } from './dto/edition-cover.dto';
import { EditionsService } from './editions.service';
import {
  Edition,
  EditionCategory,
  EditionStatus,
} from './entities/edition.entity';

/**
 * Per-edition cover artwork and the public summary behind a shared link. The
 * cases that matter: a draft must not leak through the no-login endpoint, and
 * replacing a cover must only ever delete our own cover objects.
 */
const ID = '0b6f7c1e-3d6a-4b8e-9a3c-2f1d5e7a9b10';
const OLD_KEY = 'edition-covers/11111111-1111-4111-8111-111111111111';
const NEW_KEY = 'edition-covers/22222222-2222-4222-8222-222222222222';

const edition = (over: Partial<Edition> = {}): Edition =>
  ({
    id: ID,
    name: 'GS-27 Gender and Inclusion Summit',
    shortName: 'GS-27',
    category: EditionCategory.SUMMITS,
    status: EditionStatus.ANNOUNCED,
    startsAt: new Date('2027-09-07T08:00:00+01:00'),
    endsAt: new Date('2027-09-08T17:00:00+01:00'),
    city: 'Abuja',
    venue: 'Transcorp Hilton',
    address: '1 Aguiyi Ironsi St',
    description: 'Two days on inclusion.',
    coverImage: null,
    registrationOpen: true,
    info: { wifi: { network: 'GS27', password: 'secret' } },
    ...over,
  }) as Edition;

function build(row: Edition | null, cheapest: unknown = null) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn((v: Edition) => Promise.resolve(v)),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ amount: cheapest }]),
  };
  const storage = {
    resolveStoredUrl: jest.fn((v: string | null) =>
      Promise.resolve(v ? `https://signed.example/${v}` : null),
    ),
    presignUpload: jest.fn().mockResolvedValue({ uploadUrl: 'u', key: 'k' }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EditionsService(
    repo as unknown as Repository<Edition>,
    dataSource as unknown as DataSource,
    storage as unknown as StorageService,
    {} as Redis,
    {} as CatalogService,
  );
  return { service, repo, dataSource, storage };
}

describe('EditionsService.publicSummary', () => {
  it('returns poster-level facts with a signed cover and the cheapest tier', async () => {
    const { service } = build(edition({ coverImage: OLD_KEY }), '15000');
    const view = await service.publicSummary(ID);
    expect(view).toMatchObject({
      id: ID,
      name: 'GS-27 Gender and Inclusion Summit',
      city: 'Abuja',
      coverUrl: `https://signed.example/${OLD_KEY}`,
      ticketsFrom: { amount: 15000, currency: 'NGN' },
    });
    // nothing a stranger should not see
    expect(view).not.toHaveProperty('info');
    expect(view).not.toHaveProperty('attendeePreview');
  });

  it('says free when the cheapest tier is zero, and null when nothing is on sale', async () => {
    expect(
      (await build(edition(), 0).service.publicSummary(ID)).ticketsFrom,
    ).toEqual({
      amount: 0,
      currency: 'NGN',
    });
    expect(
      (await build(edition(), null).service.publicSummary(ID)).ticketsFrom,
    ).toBeNull();
  });

  it('hides a draft exactly like a missing edition', async () => {
    await expect(
      build(edition({ status: EditionStatus.DRAFT })).service.publicSummary(ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(build(null).service.publicSummary(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('treats a malformed id as not found without touching the database', async () => {
    const { service, repo } = build(edition());
    await expect(service.publicSummary('not-an-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe('EditionsService cover', () => {
  it('presigns into the edition-covers folder', async () => {
    const { service, storage } = build(edition());
    await service.presignCover(ID, 'image/png');
    expect(storage.presignUpload).toHaveBeenCalledWith({
      folder: 'edition-covers',
      contentType: 'image/png',
    });
  });

  it('replaces a cover, saving first and then deleting the old upload', async () => {
    const { service, repo, storage } = build(edition({ coverImage: OLD_KEY }));
    const out = await service.setCover(ID, NEW_KEY);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ coverImage: NEW_KEY }),
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(OLD_KEY);
    expect(repo.save.mock.invocationCallOrder[0]).toBeLessThan(
      storage.deleteObject.mock.invocationCallOrder[0],
    );
    expect(out).toEqual({
      coverImage: NEW_KEY,
      coverUrl: `https://signed.example/${NEW_KEY}`,
    });
  });

  it('never deletes an object outside the covers folder', async () => {
    const { service, storage } = build(
      edition({ coverImage: 'delegate-avatars/abc' }),
    );
    await service.setCover(ID, NEW_KEY);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('keeps the new cover when deleting the old object fails', async () => {
    const { service, storage } = build(edition({ coverImage: OLD_KEY }));
    storage.deleteObject.mockRejectedValueOnce(new Error('S3 down'));
    await expect(service.setCover(ID, NEW_KEY)).resolves.toMatchObject({
      coverImage: NEW_KEY,
    });
  });

  it('removes a cover and its object; removing none is a no-op', async () => {
    const withCover = build(edition({ coverImage: OLD_KEY }));
    await withCover.service.removeCover(ID);
    expect(withCover.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ coverImage: null }),
    );
    expect(withCover.storage.deleteObject).toHaveBeenCalledWith(OLD_KEY);

    const without = build(edition());
    await without.service.removeCover(ID);
    expect(without.repo.save).not.toHaveBeenCalled();
  });

  it('404s for an unknown edition', async () => {
    await expect(
      build(null).service.setCover(ID, NEW_KEY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SetEditionCoverDto', () => {
  const errors = (coverImage: unknown) =>
    validate(plainToInstance(SetEditionCoverDto, { coverImage }));

  it('accepts an uploaded cover key or an https URL', async () => {
    expect(await errors(NEW_KEY)).toHaveLength(0);
    expect(await errors('https://cdn.example.org/gs27.jpg')).toHaveLength(0);
  });

  it("refuses other folders' keys, plain http and path tricks", async () => {
    for (const bad of [
      'delegate-avatars/11111111-1111-4111-8111-111111111111',
      'http://cdn.example.org/gs27.jpg',
      'edition-covers/../certificates/x',
      '',
    ]) {
      expect(await errors(bad)).not.toHaveLength(0);
    }
  });
});
