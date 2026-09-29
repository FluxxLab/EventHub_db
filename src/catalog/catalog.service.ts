import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { ILike, In, Repository } from 'typeorm';
import {
  CaptionLanguage,
  LANGUAGE_NAMES,
} from '../captions/translation/languages';
import { StorageService } from '../common/storage/storage.service';
import { REPORT_REASONS } from '../delegate/dto/report-delegate.dto';
import { INTEREST_MAX } from '../delegate/dto/update-me.dto';
import { GENDERS } from '../delegate/entities/delegate.entity';
import { Edition, EditionCategory } from '../editions/entities/edition.entity';
import { GENERAL_TRACK } from '../sessions/entities/session.entity';
import {
  PaymentCountry,
  paymentCountries,
} from '../ticketing/payment/payment-options';
import {
  CATEGORY_IMAGE_FOLDER,
  DEFAULT_CATEGORY_LABELS,
  GENDER_LABELS,
  REPORT_REASON_LABELS,
} from './catalog.constants';
import {
  CreateInterestDto,
  CreateTrackDto,
  UpdateCategoryDto,
  UpdateInterestDto,
  UpdateTrackDto,
} from './dto/catalog.dto';
import { CategorySetting } from './entities/category-setting.entity';
import { InterestOption } from './entities/interest-option.entity';
import { TrackOption } from './entities/track-option.entity';

interface Option {
  value: string;
  label: string;
}

export type TrackView = Option & { hint: string };

/** An edition's picks from the two libraries. */
export interface EditionTopics {
  trackValues: string[];
  interestValues: string[];
}

type TopicHolder = Pick<Edition, 'trackValues' | 'interestValues'>;

export interface CategoryView {
  slug: EditionCategory;
  label: string;
  /** Signed or external URL of the tile artwork, or null when unset. */
  imageUrl: string | null;
  sortOrder: number;
}

/** Every list the app renders, in one response it caches on the device. */
export interface CatalogView {
  /** sha1 of the rest; unchanged while nothing an admin controls changes. */
  version: string;
  tracks: (Option & { hint: string })[];
  interests: Option[];
  interestMax: number;
  genders: Option[];
  reportReasons: Option[];
  captionLanguages: { code: string; label: string }[];
  paymentCountries: PaymentCountry[];
  categories: CategoryView[];
}

/**
 * Reference data the app used to carry as constants. Kept here so a label,
 * a new interest or a tile photo changes without an app release.
 */
@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(InterestOption)
    private readonly interests: Repository<InterestOption>,
    @InjectRepository(CategorySetting)
    private readonly categorySettings: Repository<CategorySetting>,
    @InjectRepository(TrackOption)
    private readonly trackOptions: Repository<TrackOption>,
    @InjectRepository(Edition)
    private readonly editions: Repository<Edition>,
    private readonly storage: StorageService,
  ) {}

  /**
   * The app's lists are the current edition's: its tracks (without the
   * general bucket, which is not a theme a delegate follows) and interests.
   */
  async catalog(): Promise<CatalogView> {
    const current = await this.currentEdition();
    const [tracks, interests] = await Promise.all([
      this.editionTracks(current),
      this.editionInterests(current),
    ]);
    const categories = await this.categoryRows();
    const body = {
      tracks,
      interests,
      interestMax: INTEREST_MAX,
      genders: GENDERS.map((value) => ({ value, label: GENDER_LABELS[value] })),
      reportReasons: REPORT_REASONS.map((value) => ({
        value,
        label: REPORT_REASON_LABELS[value],
      })),
      captionLanguages: Object.values(CaptionLanguage).map((code) => ({
        code,
        label: LANGUAGE_NAMES[code],
      })),
      paymentCountries: paymentCountries(),
    };
    // Hashed on the stored image key, not the signed URL: a signature is
    // fresh on every request and would change the version every time.
    const version = createHash('sha1')
      .update(JSON.stringify({ ...body, categories }))
      .digest('hex');
    return {
      version,
      ...body,
      categories: await Promise.all(
        categories.map((c) => this.categoryView(c)),
      ),
    };
  }

  /**
   * Refuses interests that are not active options, except ones the delegate
   * already has: retiring an option must not lock a profile that holds it.
   */
  async assertInterests(requested: string[], saved: string[]): Promise<void> {
    const kept = new Set(saved);
    const fresh = [...new Set(requested)].filter((v) => !kept.has(v));
    if (fresh.length === 0) return;
    const known = await this.interests.find({
      where: { value: In(fresh), isActive: true },
      select: { value: true },
    });
    const ok = new Set(known.map((k) => k.value));
    const unknown = fresh.find((v) => !ok.has(v));
    if (unknown !== undefined) {
      throw new BadRequestException(`Unknown interest: ${unknown}`);
    }
  }

  /* -------------------------------------------------- per-edition topics */

  private currentEdition(): Promise<TopicHolder | null> {
    return this.editions.findOne({
      where: { isCurrent: true },
      select: { id: true, trackValues: true, interestValues: true },
    });
  }

  /**
   * An edition's tracks in library order, general left out. With no edition
   * (none is current yet), every active track.
   */
  async editionTracks(edition: TopicHolder | null): Promise<TrackView[]> {
    const rows = await this.picked(this.trackOptions, edition?.trackValues);
    return rows.map((t) => ({ value: t.value, label: t.label, hint: t.hint }));
  }

  async editionInterests(edition: TopicHolder | null): Promise<Option[]> {
    const rows = await this.picked(this.interests, edition?.interestValues);
    return rows.map((i) => ({ value: i.value, label: i.label }));
  }

  /** The rows an edition picked (retired ones too), or every active row without one. */
  private picked<T extends TrackOption | InterestOption>(
    repo: Repository<T>,
    values: string[] | undefined,
  ): Promise<T[]> {
    if (values && values.length === 0) return Promise.resolve([]);
    return (repo as unknown as Repository<TrackOption>).find({
      where: values ? { value: In(values) } : { isActive: true },
      order: { sortOrder: 'ASC', label: 'ASC' },
    }) as unknown as Promise<T[]>;
  }

  /**
   * What a session can be filed under in an edition: its tracks, then the
   * general bucket. `GET /sessions/tracks` for the current edition.
   */
  async sessionTracks(editionId?: string | null): Promise<TrackView[]> {
    const edition = editionId
      ? await this.editions.findOne({
          where: { id: editionId },
          select: { id: true, trackValues: true, interestValues: true },
        })
      : await this.currentEdition();
    return [...(await this.editionTracks(edition)), GENERAL_TRACK];
  }

  /** Every active value, for an edition created without choosing. */
  async defaultTopics(): Promise<EditionTopics> {
    const [tracks, interests] = await Promise.all([
      this.picked(this.trackOptions, undefined),
      this.picked(this.interests, undefined),
    ]);
    return {
      trackValues: tracks.map((t) => t.value),
      interestValues: interests.map((i) => i.value),
    };
  }

  /**
   * An edition's picks must be library values. Newly added ones must also be
   * active; one the edition already had stays even after it is retired.
   * `general` is every edition's anyway, so it is dropped rather than stored.
   */
  async cleanTopics(
    requested: Partial<EditionTopics>,
    saved: EditionTopics = { trackValues: [], interestValues: [] },
  ): Promise<Partial<EditionTopics>> {
    const out: Partial<EditionTopics> = {};
    if (requested.trackValues) {
      const values = [...new Set(requested.trackValues)].filter(
        (v) => v !== GENERAL_TRACK.value,
      );
      await this.assertKnown(
        this.trackOptions,
        values,
        saved.trackValues,
        'track',
      );
      out.trackValues = values;
    }
    if (requested.interestValues) {
      const values = [...new Set(requested.interestValues)];
      await this.assertKnown(
        this.interests,
        values,
        saved.interestValues,
        'interest',
      );
      out.interestValues = values;
    }
    return out;
  }

  private async assertKnown<T extends TrackOption | InterestOption>(
    repo: Repository<T>,
    values: string[],
    saved: string[],
    noun: string,
  ): Promise<void> {
    const kept = new Set(saved);
    const fresh = values.filter((v) => !kept.has(v));
    if (fresh.length === 0) return;
    const known = await (repo as unknown as Repository<TrackOption>).find({
      where: { value: In(fresh), isActive: true },
      select: { value: true },
    });
    const ok = new Set(known.map((k) => k.value));
    const unknown = fresh.find((v) => !ok.has(v));
    if (unknown !== undefined) {
      throw new BadRequestException(`Unknown ${noun}: ${unknown}`);
    }
  }

  /**
   * A session is filed under one of its edition's tracks or the general
   * bucket; anything else would vanish from the app's track filter.
   */
  async assertSessionTrack(
    track: string,
    editionId: string | null | undefined,
  ): Promise<void> {
    if (track === GENERAL_TRACK.value) return;
    const edition = editionId
      ? await this.editions.findOne({
          where: { id: editionId },
          select: { id: true, shortName: true, trackValues: true },
        })
      : null;
    if (!edition) return this.assertTrack(track);
    if (edition.trackValues.includes(track)) return;
    const row = await this.trackOptions.findOne({ where: { value: track } });
    throw new BadRequestException(
      `"${row?.label ?? track}" is not one of ${edition.shortName}'s tracks. Add it to the event first, or file the session under ${GENERAL_TRACK.label}.`,
    );
  }

  /** A library track (or the general bucket), for records not tied to an edition. */
  async assertTrack(track: string): Promise<void> {
    if (track === GENERAL_TRACK.value) return;
    const found = await this.trackOptions.exists({ where: { value: track } });
    if (!found) throw new BadRequestException(`Unknown track: ${track}`);
  }

  /* -------------------------------------------------------------- tracks */

  /** Every track including retired ones. Console only. */
  listTracks(): Promise<TrackOption[]> {
    return this.trackOptions.find({
      order: { sortOrder: 'ASC', label: 'ASC' },
    });
  }

  async createTrack(dto: CreateTrackDto): Promise<TrackOption> {
    const clash = await this.trackOptions.findOne({
      where: { label: ILike(escapeLike(dto.label)) },
    });
    if (
      clash ||
      dto.label.toLowerCase() === GENERAL_TRACK.label.toLowerCase()
    ) {
      throw new ConflictException(`"${dto.label}" is already a track`);
    }
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined) {
      const last = await this.trackOptions.find({
        order: { sortOrder: 'DESC' },
        take: 1,
      });
      sortOrder = last.length > 0 ? last[0].sortOrder + 1 : 0;
    }
    return this.trackOptions.save(
      this.trackOptions.create({
        value: await this.freeTrackValue(dto.label),
        label: dto.label,
        hint: dto.hint ?? '',
        sortOrder,
        isActive: true,
      }),
    );
  }

  async updateTrack(id: string, dto: UpdateTrackDto): Promise<TrackOption> {
    const row = await this.trackOptions.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Track not found');
    if (dto.label !== undefined) row.label = dto.label;
    if (dto.hint !== undefined) row.hint = dto.hint;
    if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    return this.trackOptions.save(row);
  }

  /**
   * Only a track nothing is filed under can go: sessions and pitches would
   * be left pointing at nothing. Events that picked it simply lose it.
   */
  async deleteTrack(id: string): Promise<void> {
    const row = await this.trackOptions.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Track not found');
    const used = await this.trackOptions.query(
      `SELECT 1 FROM "sessions" WHERE "track" = $1 UNION ALL SELECT 1 FROM "pitch_entries" WHERE "track" = $1 LIMIT 1`,
      [row.value],
    );
    if (used.length > 0) {
      throw new ConflictException(
        `Sessions or pitches are filed under "${row.label}". Retire it instead, so events stop offering it.`,
      );
    }
    await this.trackOptions.delete({ id });
    await this.trackOptions.query(
      `UPDATE "editions" SET "trackValues" = array_remove("trackValues", $1) WHERE $1 = ANY("trackValues")`,
      [row.value],
    );
  }

  /** "Climate & Environment" -> climate-and-environment, made unique. */
  private async freeTrackValue(label: string): Promise<string> {
    const base = trackSlug(label);
    for (let n = 1; ; n++) {
      const value = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
      if (value === GENERAL_TRACK.value) continue;
      if (!(await this.trackOptions.exists({ where: { value } }))) return value;
    }
  }

  /* ----------------------------------------------------------- interests */

  /** Every option including retired ones. Console only. */
  listInterests(): Promise<InterestOption[]> {
    return this.interests.find({ order: { sortOrder: 'ASC', label: 'ASC' } });
  }

  async createInterest(dto: CreateInterestDto): Promise<InterestOption> {
    // case-insensitive: "policy" beside "Policy" is a duplicate to a delegate
    const clash = await this.interests.findOne({
      where: { value: ILike(escapeLike(dto.value)) },
    });
    if (clash) {
      throw new ConflictException(`"${clash.value}" is already an interest`);
    }
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined) {
      const last = await this.interests.find({
        order: { sortOrder: 'DESC' },
        take: 1,
      });
      sortOrder = last.length > 0 ? last[0].sortOrder + 1 : 0;
    }
    return this.interests.save(
      this.interests.create({
        value: dto.value,
        label: dto.label ?? dto.value,
        sortOrder,
        isActive: dto.isActive ?? true,
      }),
    );
  }

  async updateInterest(
    id: string,
    dto: UpdateInterestDto,
  ): Promise<InterestOption> {
    const row = await this.interests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Interest not found');
    if (dto.label !== undefined) row.label = dto.label;
    if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    return this.interests.save(row);
  }

  /**
   * Removes the option. Delegates who saved it keep the value on their
   * profile; to stop new picks without deleting, PATCH isActive false.
   */
  async deleteInterest(id: string): Promise<void> {
    const row = await this.interests.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Interest not found');
    await this.interests.delete({ id });
    await this.interests.query(
      `UPDATE "editions" SET "interestValues" = array_remove("interestValues", $1) WHERE $1 = ANY("interestValues")`,
      [row.value],
    );
  }

  /* ---------------------------------------------------------- categories */

  async updateCategory(
    slug: EditionCategory,
    dto: UpdateCategoryDto,
  ): Promise<CategoryView> {
    const row =
      (await this.categorySettings.findOne({ where: { slug } })) ??
      this.categorySettings.create({
        slug,
        label: DEFAULT_CATEGORY_LABELS[slug],
        imageKey: null,
        sortOrder: Object.values(EditionCategory).indexOf(slug),
      });
    if (dto.label !== undefined) row.label = dto.label;
    if (dto.imageKey !== undefined) row.imageKey = dto.imageKey?.trim() || null;
    if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
    return this.categoryView(await this.categorySettings.save(row));
  }

  /** A presigned PUT for a tile's artwork; PATCH the key back as imageKey. */
  presignCategoryImage(contentType: string) {
    return this.storage.presignUpload({
      folder: CATEGORY_IMAGE_FOLDER,
      contentType,
    });
  }

  /**
   * One entry per EditionCategory, in the console's order (enum order breaks
   * ties). A category with no row gets its built-in label, so a new enum
   * value shows up before anyone has dressed it.
   */
  private async categoryRows(): Promise<CategorySetting[]> {
    const rows = await this.categorySettings.find();
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const all = Object.values(EditionCategory);
    return all
      .map((slug, index) => {
        const row = bySlug.get(slug);
        return {
          slug,
          label: row?.label ?? DEFAULT_CATEGORY_LABELS[slug],
          imageKey: row?.imageKey ?? null,
          sortOrder: row?.sortOrder ?? index,
        };
      })
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          all.indexOf(a.slug) - all.indexOf(b.slug),
      );
  }

  private async categoryView(row: CategorySetting): Promise<CategoryView> {
    return {
      slug: row.slug,
      label: row.label,
      imageUrl: await this.storage.resolveStoredUrl(row.imageKey),
      sortOrder: row.sortOrder,
    };
  }
}

/** ILike treats % and _ as wildcards; an interest value is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** A track's stored value from its label: lower case, a-z 0-9 and dashes. */
export function trackSlug(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'track';
}
