import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { IngestEventsDto } from './dto/analytics.dto';
import {
  ANALYTICS_PLATFORMS,
  AnalyticsEvent,
  type AnalyticsPlatform,
} from './entities/analytics-event.entity';

export interface AnalyticsSummary {
  from: Date;
  to: Date;
  totalEvents: number;
  /** One entry per calendar day in the range, zero-filled. */
  activeDelegates: { day: string; count: number }[];
  /** Top 30 `screen_view` paths. */
  screens: { path: string; views: number }[];
  /** Every `feature_use` feature, most used first. */
  features: { feature: string; uses: number }[];
  platforms: Record<AnalyticsPlatform, number>;
}

interface CountRow {
  count: number | string;
}
export interface DayRow extends CountRow {
  day: string;
}
interface ScreenRow {
  path: string;
  views: number | string;
}
interface FeatureRow {
  feature: string;
  uses: number | string;
}
export interface PlatformRow extends CountRow {
  platform: string;
}

/**
 * The summit happens in one place, and "how many delegates opened the app
 * on day two" means day two at the venue, not day two in UTC. Pinned here
 * rather than read from the edition because the report is one query across
 * every edition, and they have all been in Nigeria.
 */
export const REPORT_TIME_ZONE = 'Africa/Lagos';

const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
/** A row of props larger than this is a payload, not a property bag. */
const MAX_PROPS_BYTES = 2_000;

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly events: Repository<AnalyticsEvent>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * A batch from one device, written in one INSERT. The app buffers events
   * and flushes on a timer, so a request is many rows; one round trip per
   * row would make the flush slower than the screen it is reporting on.
   */
  async ingest(delegateId: string, dto: IngestEventsDto): Promise<void> {
    const rows: Omit<AnalyticsEvent, 'id' | 'receivedAt'>[] = dto.events.map(
      (e) => {
        const props = e.props ?? {};
        if (JSON.stringify(props).length > MAX_PROPS_BYTES) {
          throw new BadRequestException(
            `Event "${e.name}" carries more than ${MAX_PROPS_BYTES} bytes of props`,
          );
        }
        return {
          delegateId,
          name: e.name,
          props,
          platform: dto.platform,
          appVersion: dto.appVersion?.trim() || null,
          occurredAt: new Date(e.at),
        };
      },
    );
    // TypeORM's deep-partial type cannot express "any jsonb object" for a
    // Record<string, unknown> column; the rows above are already the full
    // shape of an insert, so the cast narrows nothing that matters.
    await this.events.insert(rows as QueryDeepPartialEntity<AnalyticsEvent>[]);
  }

  /**
   * The post-summit numbers: how much the app was used, by how many, on
   * which screens, from which platform. Aggregated in Postgres - the table
   * is every tap of every delegate - and only reshaped here.
   */
  async summary(from?: string, to?: string): Promise<AnalyticsSummary> {
    const range = AnalyticsService.range(from, to);
    const args: [Date, Date] = [range.from, range.to];
    const inRange = `"occurredAt" >= $1 AND "occurredAt" < $2`;

    const [totalRows, dayRows, screenRows, featureRows, platformRows] =
      await Promise.all([
        this.dataSource.query<CountRow[]>(
          `SELECT COUNT(*)::int AS count FROM analytics_events WHERE ${inRange}`,
          args,
        ),
        this.dataSource.query<DayRow[]>(
          `SELECT to_char("occurredAt" AT TIME ZONE '${REPORT_TIME_ZONE}', 'YYYY-MM-DD') AS day,
                  COUNT(DISTINCT "delegateId")::int AS count
           FROM analytics_events
           WHERE ${inRange} AND "delegateId" IS NOT NULL
           GROUP BY 1 ORDER BY 1`,
          args,
        ),
        this.dataSource.query<ScreenRow[]>(
          `SELECT props->>'path' AS path, COUNT(*)::int AS views
           FROM analytics_events
           WHERE ${inRange} AND name = 'screen_view' AND props ? 'path'
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 30`,
          args,
        ),
        this.dataSource.query<FeatureRow[]>(
          `SELECT props->>'feature' AS feature, COUNT(*)::int AS uses
           FROM analytics_events
           WHERE ${inRange} AND name = 'feature_use' AND props ? 'feature'
           GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
          args,
        ),
        this.dataSource.query<PlatformRow[]>(
          `SELECT platform, COUNT(*)::int AS count
           FROM analytics_events WHERE ${inRange} GROUP BY 1`,
          args,
        ),
      ]);

    return {
      from: range.from,
      to: range.to,
      totalEvents: Number(totalRows[0]?.count ?? 0),
      activeDelegates: AnalyticsService.fillDays(range, dayRows),
      screens: screenRows.map((r) => ({
        path: r.path,
        views: Number(r.views),
      })),
      features: featureRows.map((r) => ({
        feature: r.feature,
        uses: Number(r.uses),
      })),
      platforms: AnalyticsService.platformCounts(platformRows),
    };
  }

  /** Last 7 days unless given; `from` must precede `to`. */
  static range(from?: string, to?: string): { from: Date; to: Date } {
    const end = to ? new Date(to) : new Date();
    const start = from
      ? new Date(from)
      : new Date(end.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    if (start.getTime() >= end.getTime()) {
      throw new BadRequestException('from must be before to');
    }
    return { from: start, to: end };
  }

  /**
   * A day with no rows is a day with zero active delegates, and the chart
   * wants to draw that gap rather than skip it. Days are named in the
   * venue's zone, the same way the query names them.
   */
  static fillDays(
    range: { from: Date; to: Date },
    rows: DayRow[],
  ): { day: string; count: number }[] {
    const counts = new Map(rows.map((r) => [r.day, Number(r.count)]));
    const out: { day: string; count: number }[] = [];
    const push = (day: string) => {
      if (out.at(-1)?.day !== day)
        out.push({ day, count: counts.get(day) ?? 0 });
    };
    for (let t = range.from.getTime(); t <= range.to.getTime(); t += DAY_MS) {
      push(AnalyticsService.dayKey(new Date(t)));
    }
    // the range rarely ends on a day boundary; name its last partial day too
    push(AnalyticsService.dayKey(range.to));
    return out;
  }

  private static readonly dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  /** `YYYY-MM-DD` in the report zone; en-CA is the locale that prints it that way. */
  static dayKey(at: Date): string {
    return AnalyticsService.dayFmt.format(at);
  }

  /** Every platform present with a number, so the client never checks for undefined. */
  static platformCounts(
    rows: PlatformRow[],
  ): Record<AnalyticsPlatform, number> {
    const out = Object.fromEntries(
      ANALYTICS_PLATFORMS.map((p) => [p, 0]),
    ) as Record<AnalyticsPlatform, number>;
    for (const r of rows) {
      if ((ANALYTICS_PLATFORMS as readonly string[]).includes(r.platform)) {
        out[r.platform as AnalyticsPlatform] = Number(r.count);
      }
    }
    return out;
  }
}
