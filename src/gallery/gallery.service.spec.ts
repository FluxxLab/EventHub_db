import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { EditionsService } from '../editions/editions.service';
import type { GalleryAlbum, GalleryPhoto } from './entities/gallery.entities';
import { GalleryService } from './gallery.service';

/**
 * Galleries: photos only from this event's upload links, hidden albums only
 * for organisers, and deleting removes the files too.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';
const ALBUM = '33333333-3333-4333-8333-333333333333';

function setup(
  album: Partial<GalleryAlbum> | null = {
    id: ALBUM,
    editionId: EDITION,
    isPublished: true,
  },
) {
  const saved: Partial<GalleryPhoto>[] = [];
  const deleted: string[] = [];
  const albums = {
    findOneBy: jest.fn().mockResolvedValue(album),
    delete: jest.fn(),
    update: jest.fn(),
  } as unknown as Repository<GalleryAlbum>;
  const photos = {
    maximum: jest.fn().mockResolvedValue(4),
    create: jest.fn((p: Partial<GalleryPhoto>) => p),
    save: jest.fn((rows: Partial<GalleryPhoto>[]) => {
      saved.push(...rows);
      return Promise.resolve(rows.map((r, i) => ({ ...r, id: `p${i}` })));
    }),
    find: jest.fn().mockResolvedValue([
      {
        id: 'p1',
        key: `gallery/${EDITION}/a`,
        thumbKey: `gallery/${EDITION}/a-t`,
      },
    ]),
    findOneBy: jest.fn().mockResolvedValue({
      id: 'p1',
      albumId: ALBUM,
      key: `gallery/${EDITION}/a`,
      thumbKey: `gallery/${EDITION}/a-t`,
    }),
    delete: jest.fn(),
  } as unknown as Repository<GalleryPhoto>;
  const storage = {
    resolveStoredUrl: jest.fn((k: string) =>
      Promise.resolve(`https://signed/${k}`),
    ),
    deleteObject: jest.fn((k: string) => {
      deleted.push(k);
      return Promise.resolve();
    }),
  } as unknown as StorageService;
  const editions = {
    card: jest.fn().mockResolvedValue({ id: EDITION }),
  } as unknown as EditionsService;
  return {
    service: new GalleryService(
      albums,
      photos,
      {} as DataSource,
      editions,
      storage,
    ),
    saved,
    deleted,
  };
}

const photo = (key: string) => ({
  key,
  thumbKey: `${key}-t`,
  width: 4000,
  height: 3000,
  sizeBytes: 5_000_000,
});

describe('GalleryService', () => {
  it("adds this event's uploads after the album's last photo, with signed links", async () => {
    const { service, saved } = setup();
    const views = await service.addPhotos(ALBUM, {
      photos: [
        photo(`gallery/${EDITION}/x`),
        { ...photo(`gallery/${EDITION}/y`), caption: '  Opening  ' },
      ],
    });
    expect(saved.map((p) => p.sortOrder)).toEqual([5, 6]);
    expect(saved[1]).toMatchObject({ caption: 'Opening', editionId: EDITION });
    expect(views[0]).toMatchObject({
      url: `https://signed/gallery/${EDITION}/x`,
      thumbUrl: `https://signed/gallery/${EDITION}/x-t`,
    });
  });

  it("refuses files from another event's folder, or anywhere else", async () => {
    const { service } = setup();
    await expect(
      service.addPhotos(ALBUM, { photos: [photo('gallery/other-edition/x')] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.addPhotos(ALBUM, { photos: [photo('delegate-avatars/someone')] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shows a hidden album to organisers only', async () => {
    const hidden = { id: ALBUM, editionId: EDITION, isPublished: false };
    await expect(
      setup(hidden).service.photosOf(ALBUM, false),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup(hidden).service.photosOf(ALBUM, true),
    ).resolves.toMatchObject({
      photos: [expect.objectContaining({ id: 'p1' })],
    });
  });

  it('deletes the files with the photo, and with the album', async () => {
    const one = setup();
    await one.service.removePhoto('p1');
    expect(one.deleted).toEqual([
      `gallery/${EDITION}/a`,
      `gallery/${EDITION}/a-t`,
    ]);
    const all = setup();
    await all.service.remove(ALBUM);
    expect(all.deleted).toEqual([
      `gallery/${EDITION}/a`,
      `gallery/${EDITION}/a-t`,
    ]);
  });
});
