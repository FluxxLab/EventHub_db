import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { StorageService } from '../common/storage/storage.service';
import { EditionsService } from '../editions/editions.service';
import type {
  AddPhotosDto,
  SaveAlbumDto,
  UpdateAlbumDto,
  UpdatePhotoDto,
} from './dto/gallery.dto';
import { GalleryAlbum, GalleryPhoto } from './entities/gallery.entities';

export interface AlbumView {
  id: string;
  editionId: string;
  title: string;
  description: string | null;
  isPublished: boolean;
  sortOrder: number;
  photos: number;
  coverPhotoId: string | null;
  /** The cover's small copy, signed; null for an empty album. */
  coverUrl: string | null;
  createdAt: Date;
}

export interface PhotoView {
  id: string;
  albumId: string;
  /** The original, signed for 45 minutes. */
  url: string | null;
  /** The small copy, for grids. */
  thumbUrl: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  caption: string | null;
  sortOrder: number;
}

/**
 * Event photo galleries: organisers upload from the console, delegates
 * browse in the app. Photos live in private storage under
 * `gallery/<edition>/`; every read signs fresh links.
 */
@Injectable()
export class GalleryService {
  constructor(
    @InjectRepository(GalleryAlbum)
    private readonly albums: Repository<GalleryAlbum>,
    @InjectRepository(GalleryPhoto)
    private readonly photos: Repository<GalleryPhoto>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly storage: StorageService,
  ) {}

  folder(editionId: string): string {
    return `gallery/${editionId}`;
  }

  async presignPhoto(
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

  /** The edition's albums: every one for organisers, published ones for the app. */
  async list(editionId: string, includeHidden: boolean): Promise<AlbumView[]> {
    await this.editions.card(editionId);
    const albums = await this.albums.find({
      where: includeHidden ? { editionId } : { editionId, isPublished: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    if (albums.length === 0) return [];
    const ids = albums.map((a) => a.id);
    const counts: { albumId: string; n: string; first: string }[] =
      await this.dataSource.query(
        `SELECT "albumId", COUNT(*) AS n,
              (ARRAY_AGG(id ORDER BY "sortOrder", "createdAt"))[1] AS first
         FROM gallery_photos WHERE "albumId" = ANY($1::uuid[]) GROUP BY "albumId"`,
        [ids],
      );
    const byAlbum = new Map(counts.map((c) => [c.albumId, c]));
    const coverIds = albums
      .map((a) => a.coverPhotoId ?? byAlbum.get(a.id)?.first)
      .filter((id): id is string => !!id);
    const covers = coverIds.length
      ? await this.photos.find({
          where: { id: In(coverIds) },
          select: { id: true, thumbKey: true },
        })
      : [];
    const thumbOf = new Map(covers.map((p) => [p.id, p.thumbKey]));
    return Promise.all(
      albums.map(async (a) => {
        const c = byAlbum.get(a.id);
        const coverId =
          a.coverPhotoId && thumbOf.has(a.coverPhotoId)
            ? a.coverPhotoId
            : (c?.first ?? null);
        return {
          id: a.id,
          editionId: a.editionId,
          title: a.title,
          description: a.description,
          isPublished: a.isPublished,
          sortOrder: a.sortOrder,
          photos: Number(c?.n ?? 0),
          coverPhotoId: a.coverPhotoId,
          coverUrl: coverId
            ? await this.storage.resolveStoredUrl(thumbOf.get(coverId))
            : null,
          createdAt: a.createdAt,
        };
      }),
    );
  }

  async create(editionId: string, dto: SaveAlbumDto): Promise<GalleryAlbum> {
    await this.editions.card(editionId);
    const last = await this.albums.maximum('sortOrder', { editionId });
    return this.albums.save(
      this.albums.create({
        editionId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        isPublished: dto.isPublished ?? true,
        sortOrder: (last ?? -1) + 1,
      }),
    );
  }

  async update(id: string, dto: UpdateAlbumDto): Promise<GalleryAlbum> {
    const album = await this.album(id);
    if (dto.coverPhotoId) {
      const photo = await this.photos.findOneBy({
        id: dto.coverPhotoId,
        albumId: id,
      });
      if (!photo)
        throw new BadRequestException(
          'The cover must be one of the album’s photos',
        );
    }
    if (dto.title !== undefined) album.title = dto.title.trim();
    if (dto.description !== undefined)
      album.description = dto.description?.trim() || null;
    if (dto.isPublished !== undefined) album.isPublished = dto.isPublished;
    if (dto.coverPhotoId !== undefined) album.coverPhotoId = dto.coverPhotoId;
    if (dto.sortOrder !== undefined) album.sortOrder = dto.sortOrder;
    return this.albums.save(album);
  }

  /** Deletes the album, its photos and their files. */
  async remove(id: string): Promise<void> {
    const album = await this.album(id);
    const photos = await this.photos.find({ where: { albumId: id } });
    await this.albums.delete({ id: album.id });
    await this.photos.delete({ albumId: id });
    // files after the rows: a failed delete leaves an orphan file, never a broken photo
    for (const p of photos) {
      await this.storage.deleteObject(p.key).catch(() => undefined);
      await this.storage.deleteObject(p.thumbKey).catch(() => undefined);
    }
  }

  /**
   * Adds uploaded photos to an album. Every key must be one this edition's
   * upload link made, so nobody can point a photo at another event's files
   * or at someone's avatar.
   */
  async addPhotos(albumId: string, dto: AddPhotosDto): Promise<PhotoView[]> {
    const album = await this.album(albumId);
    const prefix = `${this.folder(album.editionId)}/`;
    const foreign = dto.photos.find(
      (p) => !p.key.startsWith(prefix) || !p.thumbKey.startsWith(prefix),
    );
    if (foreign)
      throw new BadRequestException(
        'Those photos were not uploaded for this event',
      );
    const last = (await this.photos.maximum('sortOrder', { albumId })) ?? -1;
    const saved = await this.photos.save(
      dto.photos.map((p, i) =>
        this.photos.create({
          albumId,
          editionId: album.editionId,
          key: p.key,
          thumbKey: p.thumbKey,
          width: p.width,
          height: p.height,
          sizeBytes: p.sizeBytes,
          caption: p.caption?.trim() || null,
          sortOrder: last + 1 + i,
        }),
      ),
    );
    return Promise.all(saved.map((p) => this.view(p)));
  }

  /** An album's photos in order; an unpublished album only for organisers. */
  async photosOf(
    albumId: string,
    includeHidden: boolean,
  ): Promise<{ album: GalleryAlbum; photos: PhotoView[] }> {
    const album = await this.album(albumId);
    if (!album.isPublished && !includeHidden)
      throw new NotFoundException('Album not found');
    const rows = await this.photos.find({
      where: { albumId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return { album, photos: await Promise.all(rows.map((p) => this.view(p))) };
  }

  async updatePhoto(id: string, dto: UpdatePhotoDto): Promise<PhotoView> {
    const photo = await this.photo(id);
    if (dto.caption !== undefined) photo.caption = dto.caption?.trim() || null;
    if (dto.sortOrder !== undefined) photo.sortOrder = dto.sortOrder;
    return this.view(await this.photos.save(photo));
  }

  async removePhoto(id: string): Promise<void> {
    const photo = await this.photo(id);
    await this.photos.delete({ id });
    await this.albums.update(
      { id: photo.albumId, coverPhotoId: id },
      { coverPhotoId: null },
    );
    await this.storage.deleteObject(photo.key).catch(() => undefined);
    await this.storage.deleteObject(photo.thumbKey).catch(() => undefined);
  }

  private async view(p: GalleryPhoto): Promise<PhotoView> {
    const [url, thumbUrl] = await Promise.all([
      this.storage.resolveStoredUrl(p.key),
      this.storage.resolveStoredUrl(p.thumbKey),
    ]);
    return {
      id: p.id,
      albumId: p.albumId,
      url,
      thumbUrl,
      width: p.width,
      height: p.height,
      sizeBytes: p.sizeBytes,
      caption: p.caption,
      sortOrder: p.sortOrder,
    };
  }

  private async album(id: string): Promise<GalleryAlbum> {
    const album = await this.albums.findOneBy({ id });
    if (!album) throw new NotFoundException('Album not found');
    return album;
  }

  private async photo(id: string): Promise<GalleryPhoto> {
    const photo = await this.photos.findOneBy({ id });
    if (!photo) throw new NotFoundException('Photo not found');
    return photo;
  }
}
