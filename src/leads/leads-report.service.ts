import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EditionsService } from '../editions/editions.service';

/** Leads at one stand in one hour of one day, Lagos time. */
export interface LeadHour {
  day: string;
  hour: number;
  leads: number;
}

export interface StandReport {
  boothId: string;
  name: string;
  location: string | null;
  isActive: boolean;
  /** Delegates who stamped their passport here (they scanned the stand). */
  stamps: number;
  /** Delegates the stand scanned (their badge). */
  leads: number;
  hot: number;
  warm: number;
  cold: number;
  /** Leads the stand's staff wrote a note about. */
  withNotes: number;
  byHour: LeadHour[];
}

export interface LeadsReport {
  editionId: string;
  /** People holding a ticket to the edition, to put the stands' reach in proportion. */
  ticketHolders: number;
  /** Delegates scanned by at least one stand. */
  delegatesScanned: number;
  stands: StandReport[];
}

type Num = string | number;

/**
 * The exhibition in numbers, for organisers and to show sponsors what their
 * stand brought them. Counts only: no names or addresses, so it can be
 * shown and passed on freely (the leads themselves come from the export).
 */
@Injectable()
export class LeadsReportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
  ) {}

  async report(editionId: string): Promise<LeadsReport> {
    await this.editions.card(editionId);
    const [stands, hours, reach, holders] = await Promise.all([
      this.dataSource.query<
        {
          boothId: string;
          name: string;
          location: string | null;
          isActive: boolean;
          stamps: Num;
          leads: Num;
          hot: Num;
          warm: Num;
          cold: Num;
          withNotes: Num;
        }[]
      >(
        `SELECT b.id AS "boothId", b.name, b.location, b."isActive",
                (SELECT COUNT(*) FROM booth_stamps s WHERE s."boothId" = b.id) AS stamps,
                COUNT(l.id) AS leads,
                COUNT(l.id) FILTER (WHERE l.rating = 'hot') AS hot,
                COUNT(l.id) FILTER (WHERE l.rating = 'warm') AS warm,
                COUNT(l.id) FILTER (WHERE l.rating = 'cold') AS cold,
                COUNT(l.id) FILTER (WHERE l.note IS NOT NULL) AS "withNotes"
           FROM booths b
           LEFT JOIN booth_leads l ON l."boothId" = b.id
          WHERE b."editionId" = $1
          GROUP BY b.id
          ORDER BY COUNT(l.id) DESC, b.name`,
        [editionId],
      ),
      this.dataSource.query<
        { boothId: string; day: string; hour: Num; leads: Num }[]
      >(
        `SELECT "boothId",
                to_char("createdAt" AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
                EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'Africa/Lagos') AS hour,
                COUNT(*) AS leads
           FROM booth_leads
          WHERE "editionId" = $1
          GROUP BY 1, 2, 3
          ORDER BY 2, 3`,
        [editionId],
      ),
      this.dataSource.query<{ n: Num }[]>(
        `SELECT COUNT(DISTINCT "delegateId") AS n FROM booth_leads WHERE "editionId" = $1`,
        [editionId],
      ),
      this.dataSource.query<{ n: Num }[]>(
        `SELECT COUNT(DISTINCT "delegateId") AS n FROM tickets WHERE "editionId" = $1 AND "delegateId" IS NOT NULL`,
        [editionId],
      ),
    ]);

    const byBooth = new Map<string, LeadHour[]>();
    for (const h of hours) {
      const list = byBooth.get(h.boothId) ?? [];
      list.push({ day: h.day, hour: Number(h.hour), leads: Number(h.leads) });
      byBooth.set(h.boothId, list);
    }
    return {
      editionId,
      ticketHolders: Number(holders[0]?.n ?? 0),
      delegatesScanned: Number(reach[0]?.n ?? 0),
      stands: stands.map((s) => ({
        boothId: s.boothId,
        name: s.name,
        location: s.location,
        isActive: s.isActive,
        stamps: Number(s.stamps),
        leads: Number(s.leads),
        hot: Number(s.hot),
        warm: Number(s.warm),
        cold: Number(s.cold),
        withNotes: Number(s.withNotes),
        byHour: byBooth.get(s.boothId) ?? [],
      })),
    };
  }
}
