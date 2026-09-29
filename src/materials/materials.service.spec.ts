import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { SessionsService } from '../sessions/sessions.service';
import {
  MaterialKind,
  SessionMaterial,
} from './entities/session-material.entity';
import { MaterialsService } from './materials.service';

/**
 * A material is a title and somewhere to fetch it from; what can go wrong is
 * handing the app a bucket key it cannot open, or a URL that expires.
 */
const material = (over: Partial<SessionMaterial> = {}): SessionMaterial => ({
  id: 'm1',
  sessionId: 's1',
  title: 'Slides',
  url: 'documents/abc.pdf',
  kind: MaterialKind.SLIDES,
  sizeLabel: '2.4 MB',
  sortOrder: 0,
  createdAt: new Date('2026-09-08T10:00:00Z'),
  ...over,
});

function build(found: SessionMaterial | null = material()) {
  const materials = {
    find: jest.fn().mockResolvedValue(found ? [found] : []),
    findOne: jest.fn().mockResolvedValue(found),
    create: jest
      .fn()
      .mockImplementation((v: Partial<SessionMaterial>) =>
        material({ ...v, id: 'new' }),
      ),
    save: jest
      .fn()
      .mockImplementation((v: SessionMaterial) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({ affected: found ? 1 : 0 }),
  };
  const sessions = { findById: jest.fn().mockResolvedValue({ id: 's1' }) };
  const storage = {
    resolveStoredUrl: jest
      .fn()
      .mockImplementation((v: string) =>
        Promise.resolve(v.startsWith('http') ? v : `https://signed/${v}`),
      ),
  };
  const service = new MaterialsService(
    materials as unknown as Repository<SessionMaterial>,
    sessions as unknown as SessionsService,
    storage as unknown as StorageService,
  );
  return { service, materials, storage };
}

describe('MaterialsService.list', () => {
  it('signs stored keys and orders by sortOrder then creation', async () => {
    const { service, materials } = build();
    const [view] = await service.list('s1');
    expect(view.url).toBe('https://signed/documents/abc.pdf');
    expect(materials.find).toHaveBeenCalledWith({
      where: { sessionId: 's1' },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  });

  it('passes an external link through untouched', async () => {
    const { service } = build(material({ url: 'https://example.org/deck' }));
    const [view] = await service.list('s1');
    expect(view.url).toBe('https://example.org/deck');
  });
});

describe('MaterialsService.create', () => {
  it('trims fields and treats an empty size label as none', async () => {
    const { service, materials } = build();
    await service.create('s1', {
      title: '  Deck ',
      url: ' documents/x.pdf ',
      kind: MaterialKind.SLIDES,
      sizeLabel: '  ',
    });
    expect(materials.create).toHaveBeenCalledWith({
      sessionId: 's1',
      title: 'Deck',
      url: 'documents/x.pdf',
      kind: MaterialKind.SLIDES,
      sizeLabel: null,
      sortOrder: 0,
    });
  });
});

describe('MaterialsService.update and remove', () => {
  it('changes only what was sent', async () => {
    const { service } = build();
    const view = await service.update('m1', { sortOrder: 3 });
    expect(view.sortOrder).toBe(3);
    expect(view.title).toBe('Slides');
  });

  it('404s for a material that does not exist', async () => {
    const { service } = build(null);
    await expect(service.update('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
