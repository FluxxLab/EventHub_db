import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../common/storage/storage.service';
import { EditionsService } from '../editions/editions.service';
import type { SaveLibraryItemDto, UpdateLibraryItemDto } from './library.dto';
import { LibraryItem, type LibraryKind } from './library-item.entity';

export interface LibraryItemView {
  id: string;
  title: string;
  description: string | null;
  kind: LibraryKind;
  /** Signed for an uploaded file, as saved for a link. */
  url: string | null;
  /** True when the file is ours (downloadable), false for a page elsewhere. */
  isFile: boolean;
  topic: string | null;
  sizeLabel: string | null;
  sortOrder: number;
  isPublished: boolean;
  updatedAt: Date;
}

export interface SessionMaterialsView {
  sessionId: string;
  sessionTitle: string;
  day: number;
  startsAt: Date;
  items: {
    id: string;
    title: string;
    kind: string;
    url: string | null;
    sizeLabel: string | null;
  }[];
}

/** Everything a delegate can learn from after (or during) an edition, in one answer for the app. */
export interface LibraryView {
  items: LibraryItemView[];
  /** Topics in the order their first resource appears. */
  topics: string[];
  sessions: SessionMaterialsView[];
  purpleBook: {
    title: string;
    url: string | null;
    sizeLabel: string | null;
  } | null;
}

const isHttp = (url: string) => /^https:\/\//i.test(url);

/**
 * The learning library: an edition's own resources, with the session
 * materials and the Purple Book gathered in, so the app has one place for
 * everything worth reading or watching again.
 */
@Injectable()
export class LibraryService {
  constructor(
    @InjectRepository(LibraryItem)
    private readonly items: Repository<LibraryItem>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly storage: StorageService,
  ) {}

  folder(editionId: string) {
    return `library/${editionId}`;
  }

  async presignFile(
    editionId: string,
    contentType: string,
    contentLength: number,
  ) {
    await this.editions.card(editionId);
    return this.storage.presignUpload({
      folder: this.folder(editionId),
      contentType,
      contentLength,
    });
  }

  /** Every resource, for organisers. */
  async manage(editionId: string): Promise<LibraryItemView[]> {
    await this.editions.card(editionId);
    const rows = await this.items.find({
      where: { editionId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async create(
    editionId: string,
    dto: SaveLibraryItemDto,
  ): Promise<LibraryItemView> {
    await this.editions.card(editionId);
    this.checkUrl(editionId, dto.url);
    const last = await this.items.maximum('sortOrder', { editionId });
    const item = await this.items.save(
      this.items.create({
        editionId,
        ...this.fields(dto),
        kind: dto.kind,
        url: dto.url.trim(),
        isPublished: dto.isPublished ?? true,
        sortOrder: dto.sortOrder ?? (last ?? -1) + 1,
      }),
    );
    return this.view(item);
  }

  async update(
    id: string,
    dto: UpdateLibraryItemDto,
  ): Promise<LibraryItemView> {
    const item = await this.item(id);
    const oldUrl = item.url;
    if (dto.url !== undefined) {
      this.checkUrl(item.editionId, dto.url);
      item.url = dto.url.trim();
    }
    if (dto.kind !== undefined) item.kind = dto.kind;
    if (dto.isPublished !== undefined) item.isPublished = dto.isPublished;
    if (dto.sortOrder !== undefined) item.sortOrder = dto.sortOrder;
    Object.assign(item, this.fields({ title: item.title, ...dto }, item));
    const saved = await this.items.save(item);
    // a replaced file is not left behind in storage
    if (oldUrl !== saved.url && !isHttp(oldUrl))
      await this.storage.deleteObject(oldUrl).catch(() => undefined);
    return this.view(saved);
  }

  async remove(id: string): Promise<void> {
    const item = await this.item(id);
    await this.items.delete({ id });
    if (!isHttp(item.url))
      await this.storage.deleteObject(item.url).catch(() => undefined);
  }

  /** The app's library: published resources, every session's materials, and the Purple Book. */
  async library(editionId: string): Promise<LibraryView> {
    await this.editions.card(editionId);
    const [rows, materials, book] = await Promise.all([
      this.items.find({
        where: { editionId, isPublished: true },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      }),
      this.dataSource.query<
        {
          sessionId: string;
          sessionTitle: string;
          day: number;
          startsAt: Date;
          id: string;
          title: string;
          kind: string;
          url: string;
          sizeLabel: string | null;
        }[]
      >(
        `SELECT s.id AS "sessionId", s.title AS "sessionTitle", s.day, s."startsAt",
                m.id, m.title, m.kind, m.url, m."sizeLabel"
           FROM session_materials m
           JOIN sessions s ON s.id = m."sessionId"
          WHERE s."editionId" = $1
          ORDER BY s.day, s."startsAt", m."sortOrder", m."createdAt"`,
        [editionId],
      ),
      this.dataSource.query<
        { title: string; url: string; sizeLabel: string | null }[]
      >(
        `SELECT title, url, "sizeLabel" FROM app_documents WHERE key = 'purple-book'`,
      ),
    ]);

    const sessions = new Map<string, SessionMaterialsView>();
    for (const m of materials) {
      const s = sessions.get(m.sessionId) ?? {
        sessionId: m.sessionId,
        sessionTitle: m.sessionTitle,
        day: Number(m.day),
        startsAt: m.startsAt,
        items: [],
      };
      s.items.push({
        id: m.id,
        title: m.title,
        kind: m.kind,
        url: await this.storage.resolveStoredUrl(m.url),
        sizeLabel: m.sizeLabel,
      });
      sessions.set(m.sessionId, s);
    }
    const items = await Promise.all(rows.map((r) => this.view(r)));
    return {
      items,
      topics: [
        ...new Set(items.map((i) => i.topic).filter((t): t is string => !!t)),
      ],
      sessions: [...sessions.values()],
      purpleBook: book[0]
        ? {
            title: book[0].title,
            url: await this.storage.resolveStoredUrl(book[0].url),
            sizeLabel: book[0].sizeLabel,
          }
        : null,
    };
  }

  /** A file must be one this edition's upload link made; anything else must be an https address. */
  private checkUrl(editionId: string, url: string) {
    const u = url.trim();
    if (isHttp(u)) return;
    if (!u.startsWith(`${this.folder(editionId)}/`)) {
      throw new BadRequestException(
        'Upload the file for this event, or give an https:// address',
      );
    }
  }

  private fields(
    dto: Partial<SaveLibraryItemDto> & { title: string },
    current?: LibraryItem,
  ) {
    return {
      title: dto.title.trim(),
      description:
        dto.description !== undefined
          ? dto.description?.trim() || null
          : (current?.description ?? null),
      topic:
        dto.topic !== undefined
          ? dto.topic?.trim() || null
          : (current?.topic ?? null),
      sizeLabel:
        dto.sizeLabel !== undefined
          ? dto.sizeLabel?.trim() || null
          : (current?.sizeLabel ?? null),
    };
  }

  private async view(r: LibraryItem): Promise<LibraryItemView> {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      kind: r.kind,
      url: await this.storage.resolveStoredUrl(r.url),
      isFile: !isHttp(r.url),
      topic: r.topic,
      sizeLabel: r.sizeLabel,
      sortOrder: r.sortOrder,
      isPublished: r.isPublished,
      updatedAt: r.updatedAt,
    };
  }

  private async item(id: string): Promise<LibraryItem> {
    const item = await this.items.findOneBy({ id });
    if (!item) throw new NotFoundException('Resource not found');
    return item;
  }
}
