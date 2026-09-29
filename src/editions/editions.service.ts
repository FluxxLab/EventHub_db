import { CatalogService } from '../catalog/catalog.service';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, In, Not, Repository } from 'typeorm';
import type Redis from 'ioredis';
import { REDIS } from '../common/redis/redis.module';
import { StorageService } from '../common/storage/storage.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { TICKET_HOLDER_TAG } from '../ticketing/ticket-holders';
import { isUUID } from 'class-validator';
import { BrowseEditionsDto } from './dto/browse-editions.dto';
import { EDITION_COVER_FOLDER } from './dto/edition-cover.dto';
import { EDITION_LOGO_FOLDER } from './dto/edition-logo.dto';
import {
  CreateEditionDto,
  EditionInfoDto,
  UpdateEditionDto,
} from './dto/create-edition.dto';
import {
  DEFAULT_TICKET_TERMS,
  Edition,
  EditionCategory,
  EditionInfo,
  EditionStatus,
} from './entities/edition.entity';
import { editionAudienceSql } from './edition-audience';
import { sortByDistance } from './geo';

/** An edition as the app's Home and event cards render it. */
export interface EditionCardView {
  id: string;
  name: string;
  shortName: string;
  category: Edition['category'];
  city: string | null;
  venue: string | null;
  /** Street address for the venue page, or null when not set. */
  address: string | null;
  startsAt: Date;
  endsAt: Date;
  status: EditionStatus;
  registrationOpen: boolean;
  description: string | null;
  /** Signed or external URL, or null when the console has set no artwork. */
  coverUrl: string | null;
  /** The event's own logo (signed or external URL), or null for none. */
  logoUrl: string | null;
  /** The event's button colour, `#rrggbb`, or null for PIC navy. */
  brandColor: string | null;
  /** Venue coordinates, or null when the console has not pinned the venue. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Distance from the caller in km, one decimal. Only on `browse` with
   * `sort=nearby`; null there for an edition with no coordinates.
   */
  distanceKm?: number | null;
  /** Delegates holding a ticket, or who saved or attended a session. */
  attendeeCount: number;
  attendeePreview: { id: string; name: string; avatarUrl: string | null }[];
  /** App surfaces switched on; the app hides the rest. */
  features: string[];
  /** Help-screen content, or null when the console has not filled it in. */
  info: EditionInfo | null;
  /** Lines printed under this edition's tickets; may be empty. */
  ticketTerms: string[];
  /** Visible (not hidden) reviews of this edition. */
  reviewCount: number;
  /** Their average rating to one decimal, or null when there are none. */
  rating: number | null;
}

export interface HomeFeed {
  popular: EditionCardView[];
  upcoming: EditionCardView[];
}

/** One tile on the app's My Events grid. */
export interface CategoryTileView {
  category: EditionCategory;
  /** Announced or live editions that have not ended. */
  upcomingCount: number;
  /** Editions that have ended, so an empty-looking tile can still say "1 past". */
  pastCount: number;
  /**
   * Artwork of the soonest upcoming edition in the category, or of the most
   * recent past one when nothing is upcoming.
   */
  coverUrl: string | null;
}

/**
 * What anyone may know about an edition without signing in: the public page
 * a shared event link opens on the web. Only what the organiser already
 * publishes on posters; no attendees, no help-desk details, no wifi password.
 */
export interface EditionPublicView {
  id: string;
  name: string;
  shortName: string;
  category: EditionCategory;
  status: EditionStatus;
  startsAt: Date;
  endsAt: Date;
  city: string | null;
  venue: string | null;
  address: string | null;
  description: string | null;
  /** Signed or external URL, or null when the console has set no artwork. */
  coverUrl: string | null;
  /** The event's own logo, or null for none. */
  logoUrl: string | null;
  /** The event's button colour, `#rrggbb`, or null for PIC navy. */
  brandColor: string | null;
  registrationOpen: boolean;
  /**
   * The cheapest active tier that can be bought, in whole naira (0 = free),
   * or null when nothing is on sale (no tiers, or invitation only).
   */
  ticketsFrom: { amount: number; currency: 'NGN' } | null;
}

/** Tables whose rows go with their event (ON DELETE CASCADE); they never block a delete. */
const EDITION_CASCADES = new Set([
  'edition_rooms',
  'email_campaigns',
  'gallery_albums',
  'library_items',
]);

/** How a refused delete names what the event still holds. */
const TABLE_LABELS: Record<string, [string, string]> = {
  sessions: ['session', 'sessions'],
  tickets: ['ticket', 'tickets'],
  orders: ['order', 'orders'],
  ticket_types: ['ticket type', 'ticket types'],
  ticket_admissions: ['check-in', 'check-ins'],
  vouchers: ['voucher', 'vouchers'],
  booths: ['exhibition booth', 'exhibition booths'],
  booth_leads: ['booth lead', 'booth leads'],
  polls: ['poll', 'polls'],
  event_reviews: ['review', 'reviews'],
  certificates: ['certificate', 'certificates'],
  notifications: ['notification', 'notifications'],
  trivia_questions: ['trivia question', 'trivia questions'],
  pitch_topics: ['pitch topic', 'pitch topics'],
  registration_entries: ['registration', 'registrations'],
};

export const countLabel = (table: string, n: number): string => {
  const [one, many] = TABLE_LABELS[table] ?? [
    table.replace(/_/g, ' ').replace(/s$/, ''),
    table.replace(/_/g, ' '),
  ];
  return `${n} ${n === 1 ? one : many}`;
};

interface AudienceRow {
  editionId: string;
  count: number;
}
interface RatingRow {
  editionId: string;
  count: number;
  average: string | number;
}
interface PreviewRow {
  editionId: string;
  id: string;
  name: string;
  avatarUrl: string | null;
}
interface AudienceStats {
  count: number;
  /** Stored avatar keys, not signed URLs: signing happens per render. */
  preview: PreviewRow[];
}

/** Redis key holding one edition's `{count, preview}` for the cards. */
export const audienceCacheKey = (editionId: string) =>
  `edition:audience:${editionId}`;
/**
 * How stale a card's "N delegates registered" line may be. Not invalidated
 * on bookmark or ticket writes: a minute behind is invisible on a card, and
 * without it every Home render at summit open re-counts every edition.
 */
export const AUDIENCE_CACHE_TTL_SECONDS = 60;

/**
 * Scope addition, 19 Sept 2026: the platform now has more than one summit in
 * it, so "which summit?" has to be a question the server can answer.
 */
@Injectable()
export class EditionsService {
  private readonly logger = new Logger(EditionsService.name);

  constructor(
    @InjectRepository(Edition)
    private readonly editions: Repository<Edition>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    @Inject(REDIS)
    private readonly redis: Redis,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * The app's Home: what is coming up, and the busiest of those first.
   *
   * "Popular" is the upcoming editions with the most delegates saving or
   * attending their sessions; there is no separate ranking to maintain. A
   * draft never appears, an ended edition only appears while nothing is
   * upcoming, so the app is never empty while there is something to show.
   */
  async home(): Promise<HomeFeed> {
    const visible = await this.editions.find({
      where: { status: Not(EditionStatus.DRAFT) },
      order: { startsAt: 'ASC' },
    });
    const now = Date.now();
    const upcomingRows = visible.filter((e) => e.endsAt.getTime() >= now);
    const pool = upcomingRows.length > 0 ? upcomingRows : visible.slice(-3);
    const cards = await this.cards(pool);
    const upcoming = upcomingRows.map((e) => cards.get(e.id)!);
    const popular = [...pool]
      .map((e) => cards.get(e.id)!)
      .sort(
        (a, b) =>
          b.attendeeCount - a.attendeeCount ||
          a.startsAt.getTime() - b.startsAt.getTime(),
      )
      .slice(0, 3);
    return { popular, upcoming };
  }

  /**
   * The app's My Events lists: one category tile, or a search across all of
   * them. Upcoming by default because a delegate browsing is looking for
   * something to attend; `past` is how they find an edition they went to.
   */
  async browse(dto: BrowseEditionsDto): Promise<EditionCardView[]> {
    if (
      dto.sort === 'nearby' &&
      (dto.lat === undefined || dto.lng === undefined)
    ) {
      throw new BadRequestException(
        'Give lat and lng to sort events by distance',
      );
    }
    const q = dto.q?.trim();
    const base = {
      status: Not(EditionStatus.DRAFT),
      ...(dto.category ? { category: dto.category } : {}),
    };
    const rows = await this.editions.find({
      where: q
        ? [
            { ...base, name: ILike(`%${q}%`) },
            { ...base, city: ILike(`%${q}%`) },
            { ...base, shortName: ILike(`%${q}%`) },
          ]
        : base,
      order: { startsAt: 'ASC' },
    });
    const now = Date.now();
    const window = EditionsService.dateWindow(dto.from, dto.to);
    // an explicit window replaces the upcoming/past split
    const when = window ? 'all' : (dto.when ?? 'upcoming');
    let filtered = rows.filter((e) =>
      window
        ? e.startsAt.getTime() >= window.from &&
          e.startsAt.getTime() <= window.to
        : when === 'all'
          ? true
          : when === 'past'
            ? e.endsAt.getTime() < now
            : e.endsAt.getTime() >= now,
    );
    if (dto.price) {
      const paid = await this.paidEditionIds(filtered.map((e) => e.id));
      filtered = filtered.filter((e) =>
        dto.price === 'paid' ? paid.has(e.id) : !paid.has(e.id),
      );
    }
    const cards = await this.cards(filtered);
    let list: EditionCardView[] = filtered.map((e) => cards.get(e.id)!);
    if (dto.sort === 'nearby') {
      list = sortByDistance(list, dto.lat!, dto.lng!);
    } else if (dto.sort === 'popular') {
      list.sort(
        (a, b) =>
          b.attendeeCount - a.attendeeCount ||
          a.startsAt.getTime() - b.startsAt.getTime(),
      );
    } else if (when === 'past') {
      list.reverse();
    }
    return list.slice(0, dto.limit ?? 50);
  }

  /**
   * Of these editions, the ones with at least one active tier priced above
   * zero. Everything else is free: all-zero tiers, invitation-only (null
   * price) tiers, or no tiers at all.
   */
  private async paidEditionIds(editionIds: string[]): Promise<Set<string>> {
    if (editionIds.length === 0) return new Set();
    const rows: { editionId: string }[] = await this.dataSource.query(
      `SELECT DISTINCT "editionId" FROM ticket_types
       WHERE "isActive" = true AND price > 0 AND "editionId" = ANY($1)`,
      [editionIds],
    );
    return new Set(rows.map((r) => r.editionId));
  }

  /**
   * The inclusive start-date window for browse, in epoch ms, or null when
   * neither end is given. A bare date means the whole of that UTC day, so
   * `to=2027-09-30` still includes an edition starting that afternoon.
   */
  static dateWindow(
    from?: string,
    to?: string,
  ): { from: number; to: number } | null {
    if (!from && !to) return null;
    const bareDate = /^\d{4}-\d{2}-\d{2}$/;
    const start = from
      ? new Date(bareDate.test(from) ? `${from}T00:00:00.000Z` : from)
      : null;
    const end = to
      ? new Date(bareDate.test(to) ? `${to}T23:59:59.999Z` : to)
      : null;
    if (
      (start && Number.isNaN(start.getTime())) ||
      (end && Number.isNaN(end.getTime()))
    ) {
      throw new BadRequestException('from and to must be ISO dates');
    }
    if (start && end && start.getTime() > end.getTime()) {
      throw new BadRequestException('from must not be after to');
    }
    return {
      from: start?.getTime() ?? -Infinity,
      to: end?.getTime() ?? Infinity,
    };
  }

  /**
   * The My Events grid: every category, with how many upcoming editions sit
   * behind it and the soonest one's artwork. All eight come back even at zero
   * so the grid keeps its shape between summits; the app decides what to do
   * with an empty tile.
   */
  async categories(): Promise<CategoryTileView[]> {
    const rows = await this.editions.find({
      where: { status: Not(EditionStatus.DRAFT) },
      order: { startsAt: 'ASC' },
    });
    const now = Date.now();
    const upcoming = rows.filter((e) => e.endsAt.getTime() >= now);
    // Most recent first, for the cover fallback.
    const past = rows.filter((e) => e.endsAt.getTime() < now).reverse();
    const tiles: CategoryTileView[] = [];
    for (const category of Object.values(EditionCategory)) {
      const mine = upcoming.filter((e) => e.category === category);
      const mineBefore = past.filter((e) => e.category === category);
      const withCover =
        mine.find((e) => e.coverImage) ?? mineBefore.find((e) => e.coverImage);
      tiles.push({
        category,
        upcomingCount: mine.length,
        pastCount: mineBefore.length,
        coverUrl: withCover
          ? await this.storage.resolveStoredUrl(withCover.coverImage)
          : null,
      });
    }
    return tiles;
  }

  /** Names for a set of ids, for other modules labelling their own rows. */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.editions.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** One edition as a card, for the app's details page. Drafts stay hidden. */
  async card(id: string): Promise<EditionCardView> {
    const edition = await this.findVisible(id);
    const cards = await this.cards([edition]);
    return cards.get(id)!;
  }

  /**
   * The no-login summary behind a shared event link. Same visibility rule as
   * `card` (a draft is a 404), and a malformed id is a 404 too rather than a
   * 400: to a visitor following a broken link they are the same thing.
   */
  async publicSummary(id: string): Promise<EditionPublicView> {
    if (!isUUID(id)) throw new NotFoundException('Edition not found');
    const e = await this.findVisible(id);
    const [coverUrl, logoUrl, ticketsFrom] = await Promise.all([
      this.storage.resolveStoredUrl(e.coverImage),
      this.storage.resolveStoredUrl(e.logoImage),
      this.cheapestTicket(id),
    ]);
    return {
      id: e.id,
      name: e.name,
      shortName: e.shortName,
      category: e.category,
      status: e.status,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      city: e.city,
      venue: e.venue,
      address: e.address ?? null,
      description: e.description,
      coverUrl,
      logoUrl,
      brandColor: e.brandColor ?? null,
      registrationOpen: e.registrationOpen,
      ticketsFrom,
    };
  }

  /** Lowest buyable price; see `EditionPublicView.ticketsFrom`. */
  private async cheapestTicket(
    editionId: string,
  ): Promise<EditionPublicView['ticketsFrom']> {
    const rows: { amount: number | string | null }[] =
      await this.dataSource.query(
        `SELECT MIN(price) AS amount FROM ticket_types
         WHERE "editionId" = $1 AND "isActive" = true AND price IS NOT NULL`,
        [editionId],
      );
    const amount = rows[0]?.amount;
    return amount === null || amount === undefined
      ? null
      : { amount: Number(amount), currency: 'NGN' };
  }

  /* ------------------------------------------------------------- cover */

  /** A presigned PUT for an edition's cover; then `setCover` with the key. */
  async presignCover(id: string, contentType: string) {
    await this.findById(id);
    return this.storage.presignUpload({
      folder: EDITION_COVER_FOLDER,
      contentType,
    });
  }

  /**
   * Set or replace the cover. The previous upload is deleted once the new
   * value is saved, so a storage failure never leaves the edition pointing at
   * nothing; only our own cover objects are ever deleted.
   */
  async setCover(
    id: string,
    coverImage: string,
  ): Promise<{ coverImage: string; coverUrl: string | null }> {
    const edition = await this.findById(id);
    const next = coverImage.trim();
    const previous = edition.coverImage;
    edition.coverImage = next;
    await this.editions.save(edition);
    if (previous && previous !== next) await this.dropCoverObject(previous);
    return {
      coverImage: next,
      coverUrl: await this.storage.resolveStoredUrl(next),
    };
  }

  /** A signed upload URL for the event's logo; see `presignCover`. */
  async presignLogo(id: string, contentType: string) {
    await this.findById(id);
    return this.storage.presignUpload({
      folder: EDITION_LOGO_FOLDER,
      contentType,
    });
  }

  /** Set or replace the logo, like `setCover`: saved first, then the old upload deleted. */
  async setLogo(
    id: string,
    logoImage: string,
  ): Promise<{ logoImage: string; logoUrl: string | null }> {
    const edition = await this.findById(id);
    const next = logoImage.trim();
    const previous = edition.logoImage;
    edition.logoImage = next;
    await this.editions.save(edition);
    if (previous && previous !== next)
      await this.dropObject(previous, EDITION_LOGO_FOLDER);
    return {
      logoImage: next,
      logoUrl: await this.storage.resolveStoredUrl(next),
    };
  }

  /** No logo: the app shows the event's short name instead. Idempotent. */
  async removeLogo(id: string): Promise<void> {
    const edition = await this.findById(id);
    const previous = edition.logoImage;
    if (!previous) return;
    edition.logoImage = null;
    await this.editions.save(edition);
    await this.dropObject(previous, EDITION_LOGO_FOLDER);
  }

  /** Back to the app's shared artwork. Idempotent. */
  async removeCover(id: string): Promise<void> {
    const edition = await this.findById(id);
    const previous = edition.coverImage;
    if (!previous) return;
    edition.coverImage = null;
    await this.editions.save(edition);
    await this.dropCoverObject(previous);
  }

  /**
   * Best effort: an orphaned object costs pennies, a failed request after
   * the row already changed would only confuse the organiser.
   */
  private async dropCoverObject(stored: string): Promise<void> {
    await this.dropObject(stored, EDITION_COVER_FOLDER);
  }

  /** Deletes an uploaded object, but only from its own folder (never an external URL). */
  private async dropObject(stored: string, folder: string): Promise<void> {
    if (!stored.startsWith(`${folder}/`)) return;
    try {
      await this.storage.deleteObject(stored);
    } catch (err) {
      this.logger.warn(
        `Could not delete old ${folder} object ${stored}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Several editions as cards in one pass (one audience lookup, one ratings
   * query), for lists that hang cards off other rows such as tickets. Same
   * visibility rule as `card`: a missing or draft id is a 404.
   */
  async cardsByIds(ids: string[]): Promise<Map<string, EditionCardView>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.editions.find({ where: { id: In(unique) } });
    const visible = rows.filter((e) => e.status !== EditionStatus.DRAFT);
    if (visible.length !== unique.length) {
      throw new NotFoundException('Edition not found');
    }
    return this.cards(visible);
  }

  /**
   * An edition a delegate may see: 404 for a draft as for a missing id, so
   * the app cannot tell an unannounced edition exists. Used by every
   * delegate-facing route hanging off an edition id.
   */
  async findVisible(id: string): Promise<Edition> {
    const edition = await this.findById(id);
    if (edition.status === EditionStatus.DRAFT) {
      throw new NotFoundException('Edition not found');
    }
    return edition;
  }

  private async cards(rows: Edition[]): Promise<Map<string, EditionCardView>> {
    const ids = rows.map((e) => e.id);
    const audience = await this.audience(ids);
    const ratings = await this.ratings(ids);
    const out = new Map<string, EditionCardView>();
    for (const e of rows) {
      const stats = audience.get(e.id) ?? { count: 0, preview: [] };
      const reviews = ratings.get(e.id);
      out.set(e.id, {
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        category: e.category,
        city: e.city,
        venue: e.venue,
        address: e.address ?? null,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        status: e.status,
        registrationOpen: e.registrationOpen,
        description: e.description,
        coverUrl: await this.storage.resolveStoredUrl(e.coverImage),
        logoUrl: await this.storage.resolveStoredUrl(e.logoImage),
        brandColor: e.brandColor ?? null,
        latitude: e.latitude ?? null,
        longitude: e.longitude ?? null,
        attendeeCount: stats.count,
        attendeePreview: await Promise.all(
          stats.preview.map(async (p) => ({
            ...p,
            avatarUrl: await this.storage.resolveAvatar(p.avatarUrl),
          })),
        ),
        features: e.features ?? [],
        info: e.info ?? null,
        ticketTerms: e.ticketTerms ?? [],
        reviewCount: reviews?.count ?? 0,
        rating: reviews?.rating ?? null,
      });
    }
    return out;
  }

  /**
   * Visible review count and average per edition, in one grouped query
   * whatever the number of cards. Hidden reviews are moderated out and do
   * not count towards either number.
   */
  private async ratings(
    editionIds: string[],
  ): Promise<Map<string, { count: number; rating: number | null }>> {
    const result = new Map<string, { count: number; rating: number | null }>();
    if (editionIds.length === 0) return result;
    const rows: RatingRow[] = await this.dataSource.query(
      `SELECT "editionId", COUNT(*)::int AS count, AVG(rating) AS average
       FROM event_reviews
       WHERE hidden = false AND "editionId" = ANY($1)
       GROUP BY "editionId"`,
      [editionIds],
    );
    for (const row of rows) {
      const count = Number(row.count);
      result.set(row.editionId, {
        count,
        // AVG over smallint arrives as a numeric string from pg
        rating: count > 0 ? Math.round(Number(row.average) * 10) / 10 : null,
      });
    }
    return result;
  }

  /**
   * Who is engaging with each edition: distinct delegates who hold a ticket
   * for it or bookmarked or attended any of its sessions, plus three of them
   * by name for the avatar stack.
   *
   * Cached per edition in Redis for AUDIENCE_CACHE_TTL_SECONDS (keys hold
   * raw avatar keys; URLs are signed after the cache). Only the misses go to
   * the database, in one batch. The attendees list
   * (`DelegatesService.listEditionAttendees`) is deliberately uncached: it is
   * filtered per caller by blocks and visibility.
   *
   * The count is everyone; the names are only people the directory would
   * list. An unclaimed ticket-holder account has not consented to being
   * shown, and flagged accounts and staff are not delegates to put a face to.
   */
  private async audience(
    editionIds: string[],
  ): Promise<Map<string, AudienceStats>> {
    const result = new Map<string, AudienceStats>();
    if (editionIds.length === 0) return result;

    const missing: string[] = [];
    const cached = await this.readAudienceCache(editionIds);
    editionIds.forEach((id, i) => {
      const hit = cached[i];
      if (hit) result.set(id, hit);
      else missing.push(id);
    });
    if (missing.length === 0) return result;

    const fresh = await this.queryAudience(missing);
    for (const id of missing) {
      // an edition nobody is engaged with is cached as zero too, or every
      // card for a quiet edition would miss forever
      result.set(id, fresh.get(id) ?? { count: 0, preview: [] });
    }
    await this.writeAudienceCache(missing.map((id) => [id, result.get(id)!]));
    return result;
  }

  /**
   * One MGET for every edition on the page. A Redis failure reads as a miss
   * for all of them: a card must still render when the cache is down.
   */
  private async readAudienceCache(
    editionIds: string[],
  ): Promise<(AudienceStats | null)[]> {
    try {
      const raw = await this.redis.mget(editionIds.map(audienceCacheKey));
      return raw.map((v) => {
        if (!v) return null;
        try {
          return JSON.parse(v) as AudienceStats;
        } catch {
          return null;
        }
      });
    } catch (err) {
      this.logger.warn(`audience cache read failed: ${String(err)}`);
      return editionIds.map(() => null);
    }
  }

  private async writeAudienceCache(
    entries: [string, AudienceStats][],
  ): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      for (const [id, stats] of entries) {
        pipeline.set(
          audienceCacheKey(id),
          JSON.stringify(stats),
          'EX',
          AUDIENCE_CACHE_TTL_SECONDS,
        );
      }
      await pipeline.exec();
    } catch (err) {
      this.logger.warn(`audience cache write failed: ${String(err)}`);
    }
  }

  /**
   * The database side of `audience`, for the editions the cache missed. One
   * round trip for the count and one for the names, whatever the number of
   * editions.
   */
  private async queryAudience(
    editionIds: string[],
  ): Promise<Map<string, AudienceStats>> {
    const result = new Map<string, AudienceStats>();
    const engaged = editionAudienceSql('= ANY($1)');
    const counts: AudienceRow[] = await this.dataSource.query(
      `SELECT "editionId", COUNT(*)::int AS count FROM (${engaged}) g GROUP BY "editionId"`,
      [editionIds],
    );
    const previews: PreviewRow[] = await this.dataSource.query(
      `SELECT "editionId", id, name, "avatarUrl" FROM (
         SELECT g."editionId", d.id, d.name, d."avatarUrl",
                ROW_NUMBER() OVER (PARTITION BY g."editionId" ORDER BY d.name) AS rn
         FROM (${engaged}) g JOIN delegates d ON d.id = g."delegateId"
         WHERE d.flagged = false
           AND d."accessTier" NOT IN ($3, $4)
           AND NOT ($2 = ANY(d.tags))
       ) t WHERE rn <= 3`,
      [
        editionIds,
        TICKET_HOLDER_TAG,
        AccessTier.ADMIN,
        AccessTier.SESSION_ADMIN,
      ],
    );
    for (const row of counts) {
      result.set(row.editionId, { count: Number(row.count), preview: [] });
    }
    for (const row of previews) {
      const entry = result.get(row.editionId);
      if (entry) entry.preview.push(row);
    }
    return result;
  }

  /**
   * What the app should show, or null when there is nothing to show.
   *
   * A draft is withheld: it is an edition being typed up in the console, and
   * announcing next year's dates by accident is the kind of mistake that
   * cannot be taken back. Null is a legitimate answer and the app has to
   * render it - between summits, there is no summit.
   */
  async current(includeDraft = false): Promise<Edition | null> {
    const edition = await this.editions.findOne({ where: { isCurrent: true } });
    if (!edition) return null;
    if (!includeDraft && edition.status === EditionStatus.DRAFT) return null;
    return edition;
  }

  /**
   * Whether an automatic push is switched off for the summit now running.
   *
   * Asked by the sessions module before it announces anything on its own.
   * Answered against whatever is current regardless of status, because a
   * draft's programme is exactly the one being reshuffled in bulk. No edition
   * at all means nothing is muted, which is how it behaved before this
   * existed.
   */
  async isMuted(kind: string): Promise<boolean> {
    const edition = await this.current(true);
    return edition?.mutedNotifications.includes(kind) ?? false;
  }

  /**
   * Every edition, newest first. Console only. With the cover and logo as
   * URLs the console can show (uploads are stored as keys).
   */
  async list(): Promise<
    (Edition & { coverUrl: string | null; logoUrl: string | null })[]
  > {
    const rows = await this.editions.find({ order: { startsAt: 'DESC' } });
    return Promise.all(
      rows.map(async (e) =>
        Object.assign(e, {
          coverUrl: await this.storage.resolveStoredUrl(e.coverImage),
          logoUrl: await this.storage.resolveStoredUrl(e.logoImage),
        }),
      ),
    );
  }

  /**
   * Deletes an event, but only one nothing depends on. Most tables that
   * belong to an event carry a plain editionId with no foreign key, so the
   * database would let the row go and leave tickets, orders and sessions
   * pointing at nothing. Every such table is found from the schema (so a
   * table added later is covered too) and counted; any rows at all refuse
   * the delete, naming what is there. Rooms, email campaigns, gallery albums
   * and library items do cascade in the database and go with the event.
   */
  async remove(id: string): Promise<void> {
    const edition = await this.findById(id);
    if (edition.isCurrent) {
      throw new ConflictException(
        `"${edition.name}" is the event the app shows. Point the app at another event before deleting it.`,
      );
    }
    const tables: { table_name: string }[] = await this.dataSource.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE column_name = 'editionId' AND table_schema = current_schema()`,
    );
    const held: string[] = [];
    for (const { table_name: table } of tables) {
      if (table === 'editions' || EDITION_CASCADES.has(table)) continue;
      const [row]: { n: number | string }[] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "editionId" = $1`,
        [id],
      );
      const n = Number(row?.n ?? 0);
      if (n > 0) held.push(countLabel(table, n));
    }
    if (held.length) {
      throw new ConflictException(
        `"${edition.name}" has ${held.join(', ')}. Only an event with nothing in it can be deleted; set it to Ended to retire it instead.`,
      );
    }
    await this.editions.delete({ id });
    if (edition.coverImage)
      await this.dropObject(edition.coverImage, EDITION_COVER_FOLDER);
    if (edition.logoImage)
      await this.dropObject(edition.logoImage, EDITION_LOGO_FOLDER);
  }

  async findById(id: string): Promise<Edition> {
    const edition = await this.editions.findOne({ where: { id } });
    if (!edition) throw new NotFoundException('Edition not found');
    return edition;
  }

  async create(dto: CreateEditionDto): Promise<Edition> {
    this.assertOrder(dto.startsAt, dto.endsAt);
    EditionsService.assertCoordinates(dto.latitude, dto.longitude);
    const defaults = await this.catalog.defaultTopics();
    const topics = await this.catalog.cleanTopics({
      trackValues: dto.trackValues ?? defaults.trackValues,
      interestValues: dto.interestValues ?? defaults.interestValues,
    });
    return this.editions.save(
      this.editions.create({
        ...dto,
        ...topics,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        venue: dto.venue?.trim() || null,
        address: dto.address?.trim() || null,
        city: dto.city?.trim() || null,
        coverImage: dto.coverImage?.trim() || null,
        brandColor: dto.brandColor?.toLowerCase() ?? null,
        description: dto.description?.trim() || null,
        ticketTerms:
          dto.ticketTerms === undefined
            ? [...DEFAULT_TICKET_TERMS]
            : EditionsService.cleanTerms(dto.ticketTerms),
      }),
    );
  }

  async update(id: string, dto: UpdateEditionDto): Promise<Edition> {
    const edition = await this.findById(id);

    // Validate against what the row will be, not only what was sent: moving
    // just the end date must still leave the edition in order.
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : edition.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : edition.endsAt;
    this.assertOrder(startsAt, endsAt);
    EditionsService.assertCoordinates(dto.latitude, dto.longitude);
    const topics = await this.catalog.cleanTopics(
      { trackValues: dto.trackValues, interestValues: dto.interestValues },
      edition,
    );

    Object.assign(edition, {
      ...dto,
      ...topics,
      startsAt,
      endsAt,
      venue:
        dto.venue === undefined ? edition.venue : dto.venue?.trim() || null,
      address:
        dto.address === undefined
          ? edition.address
          : dto.address?.trim() || null,
      ticketTerms:
        dto.ticketTerms === undefined
          ? edition.ticketTerms
          : EditionsService.cleanTerms(dto.ticketTerms),
      city: dto.city === undefined ? edition.city : dto.city?.trim() || null,
      coverImage:
        dto.coverImage === undefined
          ? edition.coverImage
          : dto.coverImage?.trim() || null,
      brandColor:
        dto.brandColor === undefined
          ? edition.brandColor
          : (dto.brandColor?.toLowerCase() ?? null),
      description:
        dto.description === undefined
          ? edition.description
          : dto.description?.trim() || null,
      // an operator clearing the box means "use the default wording"
      centreLabel:
        dto.centreLabel === undefined
          ? edition.centreLabel
          : dto.centreLabel?.trim() || null,
      // the DTO already rejects unknown keys and duplicates; keep the
      // organiser's order, it is the order the app shows the tabs in
      features: dto.features === undefined ? edition.features : dto.features,
      info:
        dto.info === undefined
          ? edition.info
          : EditionsService.cleanInfo(dto.info),
    });
    return this.editions.save(edition);
  }

  /** Trimmed, blank lines dropped: the app draws a bullet per entry. */
  static cleanTerms(terms: string[]): string[] {
    return terms.map((t) => t.trim()).filter(Boolean);
  }

  /**
   * The help-screen object as it will be stored: a plain object (not the
   * DTO instance), every string trimmed, every blank string and empty list
   * dropped, and null when nothing is left. The app renders a section per
   * key it finds, so a key holding "" would draw an empty section.
   */
  static cleanInfo(dto: EditionInfoDto | null): EditionInfo | null {
    if (!dto) return null;
    const text = (v: string | undefined): string | undefined =>
      v?.trim() || undefined;
    const info: EditionInfo = {};

    /** Only the keys that hold something, so the stored object has no `undefined`s. */
    const compact = <T extends object>(obj: T): T =>
      Object.fromEntries(
        Object.entries(obj).filter(([, v]) => v !== undefined),
      ) as T;

    const network = text(dto.wifi?.network);
    if (network) {
      info.wifi = compact({ network, password: text(dto.wifi?.password) });
    }

    const helpDesk = compact({
      phone: text(dto.helpDesk?.phone),
      whatsapp: text(dto.helpDesk?.whatsapp),
      email: text(dto.helpDesk?.email)?.toLowerCase(),
      location: text(dto.helpDesk?.location),
    });
    if (Object.keys(helpDesk).length > 0) info.helpDesk = helpDesk;

    const breaks = (dto.breaks ?? [])
      .filter((b) => text(b.label))
      .map((b) =>
        compact({
          label: text(b.label) ?? '',
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          location: text(b.location),
        }),
      );
    if (breaks.length > 0) info.breaks = breaks;

    const prayerRoom = text(dto.prayerRoom);
    if (prayerRoom) info.prayerRoom = prayerRoom;
    const transport = text(dto.transport);
    if (transport) info.transport = transport;
    const floorPlanUrl = text(dto.floorPlanUrl);
    if (floorPlanUrl) info.floorPlanUrl = floorPlanUrl;

    const notes = (dto.notes ?? []).map((n) => n.trim()).filter(Boolean);
    if (notes.length > 0) info.notes = notes;

    return Object.keys(info).length > 0 ? info : null;
  }

  /**
   * Point the app at one edition.
   *
   * In a transaction because there is a moment between clearing the old
   * current and setting the new one where no edition is current, and a
   * delegate opening the app in that window would be told the summit does not
   * exist. The partial unique index also means the clear has to land first.
   */
  async setCurrent(id: string): Promise<Edition> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Edition);
      const edition = await repo.findOne({ where: { id } });
      if (!edition) throw new NotFoundException('Edition not found');
      // A draft is an edition still being typed up. Pointing the app at one
      // would publish half a programme and next year's dates, and because
      // sessions are scoped to whatever is current, it would do it silently.
      if (edition.status === EditionStatus.DRAFT) {
        throw new BadRequestException(
          'Announce the edition before making it current',
        );
      }

      await repo.update({ isCurrent: true, id: Not(id) }, { isCurrent: false });
      edition.isCurrent = true;
      return repo.save(edition);
    });
  }

  /**
   * Half a coordinate is a pin in the wrong place, not a missing one: both
   * are sent together (or both left out, or both null to clear).
   */
  static assertCoordinates(
    latitude: number | null | undefined,
    longitude: number | null | undefined,
  ): void {
    const sent = (v: unknown) => v !== undefined;
    const set = (v: unknown) => v !== undefined && v !== null;
    if (
      sent(latitude) !== sent(longitude) ||
      set(latitude) !== set(longitude)
    ) {
      throw new BadRequestException('Give both latitude and longitude');
    }
  }

  private assertOrder(startsAt: Date | string, endsAt: Date | string): void {
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw new BadRequestException('An edition must end after it starts');
    }
  }
}
