import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EditionVia } from './edition-scope.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_CODE = /^PICT1\.([0-9a-f-]{36})\./i;
/** How long an event organiser's assignments are trusted before re-reading them. */
export const ASSIGNMENT_TTL_MS = 30_000;

/**
 * One query per kind of record: its edition, by the record's id. Sessions
 * are the join for anything filed under one. Never built from input - the
 * id is always a bound parameter.
 */
const EDITION_OF: Record<
  Exclude<EditionVia, 'edition' | 'sessions' | 'ticketCode'>,
  string
> = {
  session: `SELECT "editionId" FROM sessions WHERE id = $1`,
  poll: `SELECT COALESCE(p."editionId", s."editionId") AS "editionId" FROM polls p LEFT JOIN sessions s ON s.id = p."sessionId" WHERE p.id = $1`,
  comment: `SELECT s."editionId" FROM session_comments c JOIN sessions s ON s.id = c."sessionId" WHERE c.id = $1`,
  question: `SELECT s."editionId" FROM session_questions q JOIN sessions s ON s.id = q."sessionId" WHERE q.id = $1`,
  material: `SELECT s."editionId" FROM session_materials m JOIN sessions s ON s.id = m."sessionId" WHERE m.id = $1`,
  room: `SELECT "editionId" FROM edition_rooms WHERE id = $1`,
  booth: `SELECT "editionId" FROM booths WHERE id = $1`,
  ticketType: `SELECT "editionId" FROM ticket_types WHERE id = $1`,
  review: `SELECT "editionId" FROM event_reviews WHERE id = $1`,
  trivia: `SELECT "editionId" FROM trivia_questions WHERE id = $1`,
  pitchTopic: `SELECT "editionId" FROM pitch_topics WHERE id = $1`,
  pitchEntry: `SELECT t."editionId" FROM pitch_entries e JOIN pitch_topics t ON t.id = e."topicId" WHERE e.id = $1`,
  notification: `SELECT "editionId" FROM notifications WHERE id = $1`,
  campaign: `SELECT "editionId" FROM email_campaigns WHERE id = $1`,
  galleryAlbum: `SELECT "editionId" FROM gallery_albums WHERE id = $1`,
  galleryPhoto: `SELECT "editionId" FROM gallery_photos WHERE id = $1`,
  libraryItem: `SELECT "editionId" FROM library_items WHERE id = $1`,
  meal: `SELECT "editionId" FROM meals WHERE id = $1`,
  mealCounter: `SELECT "editionId" FROM meal_counters WHERE id = $1`,
};

/**
 * Which editions an event organiser runs, and which edition a request is
 * about. Assignments are cached per instance for a short while (every
 * request an event organiser makes needs them) and forgotten the moment
 * they are changed here.
 */
@Injectable()
export class EditionAccessService {
  private readonly cache = new Map<string, { ids: string[]; until: number }>();

  constructor(private readonly dataSource: DataSource) {}

  async editionsOf(userId: string): Promise<string[]> {
    const hit = this.cache.get(userId);
    if (hit && hit.until > Date.now()) return hit.ids;
    const rows = await this.dataSource.query(
      `SELECT "managedEditionIds" FROM delegates WHERE id = $1 AND "accessTier" = 'event_admin'`,
      [userId],
    );
    const ids = rows[0]?.managedEditionIds ?? [];
    this.cache.set(userId, { ids, until: Date.now() + ASSIGNMENT_TTL_MS });
    return ids;
  }

  /** Called when an account's role or assignments change. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }

  async currentEdition(): Promise<string | null> {
    const rows = await this.dataSource.query(
      `SELECT id FROM editions WHERE "isCurrent" = true LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  /**
   * The editions a value belongs to. Unknown or malformed values give none,
   * which the guard refuses: an event organiser learns nothing about a
   * record they cannot reach, not even whether it exists.
   */
  async editionsFor(via: EditionVia, value: unknown): Promise<string[]> {
    if (via === 'sessions') {
      const ids = Array.isArray(value)
        ? value.filter(
            (v): v is string => typeof v === 'string' && UUID.test(v),
          )
        : [];
      if (ids.length === 0 || ids.length !== (value as unknown[]).length)
        return [];
      const rows = await this.dataSource.query<
        { id: string; editionId: string | null }[]
      >(`SELECT id, "editionId" FROM sessions WHERE id = ANY($1)`, [ids]);
      // every session must exist and belong somewhere
      const editions = rows.map((r) => r.editionId);
      if (rows.length !== new Set(ids).size || editions.some((e) => !e))
        return [];
      return [...new Set(editions.filter((e): e is string => Boolean(e)))];
    }
    if (typeof value !== 'string') return [];
    if (via === 'ticketCode') {
      const id = TICKET_CODE.exec(value.trim())?.[1];
      if (!id || !UUID.test(id)) return [];
      return this.single(`SELECT "editionId" FROM tickets WHERE id = $1`, id);
    }
    if (!UUID.test(value)) return [];
    if (via === 'edition') return [value];
    return this.single(EDITION_OF[via], value);
  }

  private async single(sql: string, id: string): Promise<string[]> {
    const rows = await this.dataSource.query(sql, [id]);
    const editionId = rows[0]?.editionId;
    return editionId ? [editionId] : [];
  }
}
