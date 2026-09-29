import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { EditionsService } from '../editions/editions.service';
import type { LibraryItem } from './library-item.entity';
import { LibraryService } from './library.service';

/**
 * The learning library: files only from this event's upload link or https
 * addresses, a replaced file removed from storage, and the app's view
 * bringing in session materials and the Purple Book.
 */
const EDITION = '22222222-2222-4222-8222-222222222222';

function setup(item: Partial<LibraryItem> = {}) {
  const deleted: string[] = [];
  const row = {
    id: 'i1',
    editionId: EDITION,
    title: 'Toolkit',
    kind: 'document',
    url: `library/${EDITION}/old`,
    description: null,
    topic: null,
    sizeLabel: null,
    sortOrder: 0,
    isPublished: true,
    updatedAt: new Date(),
    ...item,
  } as LibraryItem;
  const items = {
    maximum: jest.fn().mockResolvedValue(2),
    create: jest.fn((v: Partial<LibraryItem>) => v),
    save: jest.fn((v: LibraryItem) =>
      Promise.resolve({ ...v, id: v.id ?? 'new', updatedAt: new Date() }),
    ),
    findOneBy: jest.fn().mockResolvedValue(row),
    find: jest.fn().mockResolvedValue([
      row,
      {
        ...row,
        id: 'i2',
        title: 'Explainer',
        kind: 'video',
        url: 'https://youtu.be/x',
        topic: 'Budgets',
      },
    ]),
    delete: jest.fn(),
  } as unknown as Repository<LibraryItem>;
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      {
        sessionId: 's1',
        sessionTitle: 'Opening plenary',
        day: 1,
        startsAt: new Date(),
        id: 'm1',
        title: 'Slides',
        kind: 'slides',
        url: 'documents/abc',
        sizeLabel: '2 MB',
      },
      {
        sessionId: 's1',
        sessionTitle: 'Opening plenary',
        day: 1,
        startsAt: new Date(),
        id: 'm2',
        title: 'Recording',
        kind: 'recording',
        url: 'https://youtu.be/y',
        sizeLabel: null,
      },
    ])
    .mockResolvedValueOnce([
      {
        title: 'The Purple Book 2027',
        url: 'documents/pb',
        sizeLabel: '6.8 MB',
      },
    ]);
  const storage = {
    resolveStoredUrl: jest.fn((k: string) =>
      Promise.resolve(k.startsWith('https://') ? k : `https://signed/${k}`),
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
    service: new LibraryService(
      items,
      { query } as unknown as DataSource,
      editions,
      storage,
    ),
    deleted,
  };
}

describe('LibraryService', () => {
  it("takes this event's uploads and https links, nothing else", async () => {
    const { service } = setup();
    await expect(
      service.create(EDITION, {
        title: 'T',
        kind: 'document',
        url: `library/${EDITION}/f`,
      }),
    ).resolves.toMatchObject({ isFile: true, sortOrder: 3 });
    await expect(
      service.create(EDITION, {
        title: 'T',
        kind: 'link',
        url: 'https://unwomen.org/report',
      }),
    ).resolves.toMatchObject({ isFile: false });
    await expect(
      service.create(EDITION, {
        title: 'T',
        kind: 'document',
        url: 'library/other/f',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(EDITION, {
        title: 'T',
        kind: 'link',
        url: 'http://insecure.example',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes a replaced file from storage, but never a link', async () => {
    const replaced = setup();
    await replaced.service.update('i1', { url: `library/${EDITION}/new` });
    expect(replaced.deleted).toEqual([`library/${EDITION}/old`]);
    const link = setup({ url: 'https://old.example/page' });
    await link.service.update('i1', { url: 'https://new.example/page' });
    expect(link.deleted).toEqual([]);
  });

  it('gathers resources, session materials and the Purple Book for the app', async () => {
    const view = await setup().service.library(EDITION);
    expect(view.items.map((i) => i.title)).toEqual(['Toolkit', 'Explainer']);
    expect(view.topics).toEqual(['Budgets']);
    expect(view.sessions).toEqual([
      expect.objectContaining({
        sessionTitle: 'Opening plenary',
        items: [
          expect.objectContaining({ url: 'https://signed/documents/abc' }),
          expect.objectContaining({ url: 'https://youtu.be/y' }),
        ],
      }),
    ]);
    expect(view.purpleBook).toEqual({
      title: 'The Purple Book 2027',
      url: 'https://signed/documents/pb',
      sizeLabel: '6.8 MB',
    });
  });
});
