import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { CatalogService } from '../catalog/catalog.service';
import type { StorageService } from '../common/storage/storage.service';
import { UpdateEditionDto } from './dto/create-edition.dto';
import { SetEditionLogoDto } from './dto/edition-logo.dto';
import { EditionsService } from './editions.service';
import type { Edition } from './entities/edition.entity';

/**
 * Per-event branding: the logo follows the cover's rules (only our own logo
 * objects are ever deleted), and the button colour is plain #rrggbb.
 */
const ID = '0b6f7c1e-3d6a-4b8e-9a3c-2f1d5e7a9b10';
const OLD_KEY = 'edition-logos/11111111-1111-4111-8111-111111111111';
const NEW_KEY = 'edition-logos/22222222-2222-4222-8222-222222222222';

function build(row: Partial<Edition> | null) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn((v: Edition) => Promise.resolve(v)),
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
    {} as DataSource,
    storage as unknown as StorageService,
    {} as Redis,
    {} as CatalogService,
  );
  return { service, repo, storage };
}

describe('EditionsService logo', () => {
  it('presigns into the edition-logos folder', async () => {
    const { service, storage } = build({ id: ID });
    await service.presignLogo(ID, 'image/png');
    expect(storage.presignUpload).toHaveBeenCalledWith({
      folder: 'edition-logos',
      contentType: 'image/png',
    });
  });

  it('replaces a logo, saving first and then deleting the old upload', async () => {
    const { service, repo, storage } = build({ id: ID, logoImage: OLD_KEY });
    const out = await service.setLogo(ID, NEW_KEY);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ logoImage: NEW_KEY }),
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(OLD_KEY);
    expect(out).toEqual({
      logoImage: NEW_KEY,
      logoUrl: `https://signed.example/${NEW_KEY}`,
    });
  });

  it('never deletes a cover or any other folder when the logo changes', async () => {
    const { service, storage } = build({
      id: ID,
      logoImage: 'edition-covers/11111111-1111-4111-8111-111111111111',
    });
    await service.setLogo(ID, NEW_KEY);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('removes a logo and its object; removing none is a no-op', async () => {
    const withLogo = build({ id: ID, logoImage: OLD_KEY });
    await withLogo.service.removeLogo(ID);
    expect(withLogo.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ logoImage: null }),
    );
    expect(withLogo.storage.deleteObject).toHaveBeenCalledWith(OLD_KEY);

    const without = build({ id: ID, logoImage: null });
    await without.service.removeLogo(ID);
    expect(without.repo.save).not.toHaveBeenCalled();
  });
});

describe('Branding DTOs', () => {
  it('accepts an uploaded logo key or an https URL, and nothing else', async () => {
    const errors = (logoImage: unknown) =>
      validate(plainToInstance(SetEditionLogoDto, { logoImage }));
    expect(await errors(NEW_KEY)).toHaveLength(0);
    expect(await errors('https://cdn.example.org/logo.png')).toHaveLength(0);
    for (const bad of [
      'edition-covers/11111111-1111-4111-8111-111111111111',
      'http://cdn.example.org/logo.png',
      '',
    ]) {
      expect(await errors(bad)).not.toHaveLength(0);
    }
  });

  it('takes a #rrggbb button colour, or null to go back to PIC navy', async () => {
    const errors = (brandColor: unknown) =>
      validate(plainToInstance(UpdateEditionDto, { brandColor }));
    expect(await errors('#0f6b3a')).toHaveLength(0);
    expect(await errors('#0F6B3A')).toHaveLength(0);
    expect(await errors(null)).toHaveLength(0);
    for (const bad of ['0f6b3a', '#fff', 'red', '#0f6b3a; x']) {
      expect(await errors(bad)).not.toHaveLength(0);
    }
  });
});
