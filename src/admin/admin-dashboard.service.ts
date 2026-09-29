import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  AnalyticsService,
  REPORT_TIME_ZONE,
} from '../analytics/analytics.service';
import { REDIS } from '../common/redis/redis.module';
import { StorageService } from '../common/storage/storage.service';
import { PresenceService } from '../delegate/presence.service';
import { EditionsService } from '../editions/editions.service';
import type { Edition } from '../editions/entities/edition.entity';
import { paymentCountries } from '../ticketing/payment/payment-options';
import { TICKET_HOLDER_TAG } from '../ticketing/ticket-holders';

export type Compare = {
  current: number;
  previous: number;
  currentLabel: string;
  previousLabel: string;
};
/** change: % vs the previous period, one decimal; null when previous is 0. */
export type TableRow = { label: string; value: number; change: number | null };
/** day: YYYY-MM-DD in the venue's zone, zero-filled. */
export type DayValue = { day: string; value: number };
type Severity = 'info' | 'warning' | 'critical';

export interface DashboardView {
  generatedAt: string;
  edition: {
    id: string;
    name: string;
    shortName: string;
    startsAt: string;
    endsAt: string;
    status: string;
  } | null;
  /** The currency most paid orders of the edition used. */
  currency: string;
  kpis: {
    ticketsSold: Compare;
    averageOrder: Compare;
    revenue: Compare;
    delegates: Compare;
  };
  orderStatus: {
    paid: number;
    pending: number;
    cancelled: number;
    ticketsIssued: number;
    admitted: number;
    unclaimedHolders: number;
  };
  geography: {
    country: string;
    name: string;
    orders: number;
    tickets: number;
  }[];
  tables: { screens: TableRow[]; countries: TableRow[]; tiers: TableRow[] };
  spark: {
    revenue: { total: number; paidOrders: number; daily: DayValue[] };
    activeDelegates: { today: number; onlineNow: number; daily: DayValue[] };
    engagement: {
      rate: number;
      daily: { day: string; questions: number; pollVotes: number }[];
    };
  };
  activity: {
    at: string;
    type: string;
    description: string;
    severity: Severity;
  }[];
  recentOrders: {
    at: string;
    id: string;
    buyer: string;
    total: number;
    currency: string;
    tickets: number;
  }[];
  recentDelegates: { id: string; name: string; avatarUrl: string | null }[];
}

/** pg hands back bigint and numeric aggregates as strings. */
type Num = number | string | null;

interface CountsRow {
  paid: Num;
  pending: Num;
  cancelled: Num;
  admitted: Num;
  holders: Num;
  unclaimed: Num;
  engaged: Num;
  delegates_cur: Num;
  delegates_prev: Num;
}
interface PaidRow {
  country: string;
  currency: string;
  orders: Num;
  tickets: Num;
  cur_orders: Num;
  cur_tickets: Num;
  cur_revenue: Num;
  prev_orders: Num;
  prev_tickets: Num;
  prev_revenue: Num;
}
interface RevenueDayRow {
  currency: string;
  day: string;
  value: Num;
  orders: Num;
}
interface PeriodRow {
  label: string;
  total?: Num;
  cur: Num;
  prev: Num;
}
interface RecentOrderRow {
  id: string;
  at: Date | string;
  buyer: string;
  total: Num;
  currency: string;
  tickets: Num;
}
interface RecentDelegateRow {
  id: string;
  name: string;
  avatarUrl: string | null;
}
interface ActivityRow {
  at: Date | string;
  type: string;
  description: string;
  severity: Severity;
}
interface DayCountRow {
  day: string;
  count: Num;
}
interface EngagementDayRow extends DayCountRow {
  kind: 'q' | 'p';
}

export const dashboardCacheKey = (editionId: string) =>
  `admin:dashboard:${editionId}`;
export const DASHBOARD_CACHE_TTL_SECONDS = 30;
/** Orders predate the currency column's use; this is what they were priced in. */
const FALLBACK_CURRENCY = 'NGN';
const SPARK_DAYS = 14;
const DAY_MS = 86_400_000;

/** Ticket places on an order: the sum of its line quantities. */
const ORDER_QTY = `(SELECT COALESCE(SUM((l->>'quantity')::int), 0)
                    FROM jsonb_array_elements(o.lines) l)`;
/** Mirrors normaliseCountry: an order with no country was priced as Nigeria. */
const ORDER_COUNTRY = `COALESCE(NULLIF(UPPER(TRIM(o.country)), ''), 'NG')`;
const lagosDay = (col: string) =>
  `to_char(${col} AT TIME ZONE '${REPORT_TIME_ZONE}', 'YYYY-MM-DD')`;

const n = (v: Num | undefined): number => Number(v ?? 0) || 0;
const iso = (v: Date | string): string => new Date(v).toISOString();

/** % change, one decimal; null when there is nothing to compare against. */
export function changePct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const monthFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  month: 'short',
  year: 'numeric',
});

function zoneParts(at: Date) {
  const p = Object.fromEntries(
    partsFmt.formatToParts(at).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    h: p.hour,
    mi: p.minute,
    s: p.second,
  };
}

/** Midnight of a calendar date in the venue's zone, as an instant. Overflowing days/months roll over. */
export function zonedMidnight(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d);
  const p = zoneParts(new Date(guess));
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess;
  return new Date(guess - offset);
}

/** Every boundary the dashboard compares across, computed once per build. */
export function dashboardWindows(now: Date) {
  const { y, m, d } = zoneParts(now);
  const thisMonth = zonedMidnight(y, m, 1);
  const lastMonth = zonedMidnight(y, m - 1, 1);
  const nextMonth = zonedMidnight(y, m + 1, 1);
  const sparkFrom = zonedMidnight(y, m, d - (SPARK_DAYS - 1));
  const days = Array.from({ length: SPARK_DAYS }, (_, i) =>
    AnalyticsService.dayKey(zonedMidnight(y, m, d - (SPARK_DAYS - 1) + i)),
  );
  return {
    thisMonth,
    lastMonth,
    nextMonth,
    currentLabel: monthFmt.format(thisMonth),
    previousLabel: monthFmt.format(lastMonth),
    sparkFrom,
    days,
    week: new Date(now.getTime() - 7 * DAY_MS),
    fortnight: new Date(now.getTime() - 14 * DAY_MS),
  };
}

const countryNames = new Map(
  paymentCountries().map((c) => [c.code, c.name] as const),
);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code: string): string {
  const known = countryNames.get(code);
  if (known) return known;
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code; // not a valid region code
  }
}

/**
 * GET /admin/dashboard: every figure on the organiser's home screen in one
 * view. Ten aggregate queries in parallel, reshaped here; the whole view is
 * cached per edition for DASHBOARD_CACHE_TTL_SECONDS, so a room of organisers
 * refreshing the dashboard costs one build every 30 s.
 *
 * Analytics and security events are not edition-scoped in their tables, so
 * the screens table, active delegates and activity feed are summit-wide.
 */
@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly storage: StorageService,
    @Inject(REDIS) private readonly redis: Redis,
    /** Online now; optional so the hand-built specs need not supply it. */
    @Optional() private readonly presence?: PresenceService,
  ) {}

  async dashboard(editionId?: string): Promise<DashboardView> {
    const edition = editionId
      ? await this.editions.findById(editionId)
      : await this.editions.current(true);
    const key = dashboardCacheKey(edition?.id ?? 'none');

    const cached = await this.readCache(key);
    const view =
      cached ??
      (edition
        ? await this.build(edition, new Date())
        : AdminDashboardService.empty(new Date()));
    if (!cached) await this.writeCache(key, view);
    return this.withOnlineNow(view);
  }

  /**
   * Online now is laid over the cached view on every request rather than
   * cached with it: it is one cheap Redis read, and 30 s old would be wrong
   * for the one number on the page that claims to be live. Summit-wide, like
   * the rest of the active-delegates card.
   */
  private async withOnlineNow(view: DashboardView): Promise<DashboardView> {
    if (!this.presence) return view;
    const onlineNow = await this.presence.onlineCount();
    return {
      ...view,
      spark: {
        ...view.spark,
        activeDelegates: { ...view.spark.activeDelegates, onlineNow },
      },
    };
  }

  /** No edition: the shape with zeros, so the dashboard renders rather than 404s. */
  static empty(now: Date): DashboardView {
    const w = dashboardWindows(now);
    const cmp = (): Compare => ({
      current: 0,
      previous: 0,
      currentLabel: w.currentLabel,
      previousLabel: w.previousLabel,
    });
    return {
      generatedAt: now.toISOString(),
      edition: null,
      currency: FALLBACK_CURRENCY,
      kpis: {
        ticketsSold: cmp(),
        averageOrder: cmp(),
        revenue: cmp(),
        delegates: cmp(),
      },
      orderStatus: {
        paid: 0,
        pending: 0,
        cancelled: 0,
        ticketsIssued: 0,
        admitted: 0,
        unclaimedHolders: 0,
      },
      geography: [],
      tables: { screens: [], countries: [], tiers: [] },
      spark: {
        revenue: {
          total: 0,
          paidOrders: 0,
          daily: w.days.map((day) => ({ day, value: 0 })),
        },
        activeDelegates: {
          today: 0,
          onlineNow: 0,
          daily: w.days.map((day) => ({ day, value: 0 })),
        },
        engagement: {
          rate: 0,
          daily: w.days.map((day) => ({ day, questions: 0, pollVotes: 0 })),
        },
      },
      activity: [],
      recentOrders: [],
      recentDelegates: [],
    };
  }

  private async build(edition: Edition, now: Date): Promise<DashboardView> {
    const w = dashboardWindows(now);
    const id = edition.id;
    const q = <T>(tag: string, sql: string, params: unknown[]) =>
      this.dataSource.query<T[]>(`/* dashboard:${tag} */ ${sql}`, params);

    const [
      counts,
      paid,
      revenueDays,
      tiers,
      recentOrders,
      recentDelegates,
      activity,
      screens,
      activeDays,
      engagementDays,
    ] = await Promise.all([
      q<CountsRow>(
        'counts',
        `WITH holders AS (
           SELECT "delegateId" AS id, MIN("createdAt") AS first
           FROM tickets WHERE "editionId" = $1 GROUP BY 1
         ),
         engaged AS (
           SELECT sq."delegateId" AS id FROM session_questions sq
             JOIN sessions s ON s.id = sq."sessionId" WHERE s."editionId" = $1
           UNION
           SELECT qv."delegateId" FROM question_votes qv
             JOIN session_questions sq ON sq.id = qv."questionId"
             JOIN sessions s ON s.id = sq."sessionId" WHERE s."editionId" = $1
           UNION
           SELECT pv."delegateId" FROM poll_votes pv
             JOIN polls p ON p.id = pv."pollId" WHERE p."editionId" = $1
           UNION
           SELECT f."delegateId" FROM session_feedback f
             JOIN sessions s ON s.id = f."sessionId" WHERE s."editionId" = $1
         )
         SELECT
           (SELECT COUNT(*) FROM orders WHERE "editionId" = $1 AND status = 'paid')::int AS paid,
           (SELECT COUNT(*) FROM orders WHERE "editionId" = $1 AND status = 'pending')::int AS pending,
           (SELECT COUNT(*) FROM orders WHERE "editionId" = $1 AND status = 'cancelled')::int AS cancelled,
           (SELECT COUNT(*) FROM ticket_admissions WHERE "editionId" = $1)::int AS admitted,
           (SELECT COUNT(*) FROM holders)::int AS holders,
           (SELECT COUNT(*) FROM holders h JOIN delegates d ON d.id = h.id
              WHERE $5 = ANY(d.tags))::int AS unclaimed,
           (SELECT COUNT(*) FROM holders h JOIN engaged e ON e.id = h.id)::int AS engaged,
           (SELECT COUNT(*) FROM holders WHERE first >= $3 AND first < $4)::int AS delegates_cur,
           (SELECT COUNT(*) FROM holders WHERE first >= $2 AND first < $3)::int AS delegates_prev`,
        [id, w.lastMonth, w.thisMonth, w.nextMonth, TICKET_HOLDER_TAG],
      ),
      q<PaidRow>(
        'paid',
        `SELECT country, currency,
                COUNT(*)::int AS orders,
                SUM(qty)::int AS tickets,
                COUNT(*) FILTER (WHERE cur)::int AS cur_orders,
                COALESCE(SUM(qty) FILTER (WHERE cur), 0)::int AS cur_tickets,
                COALESCE(SUM(total) FILTER (WHERE cur), 0)::bigint AS cur_revenue,
                COUNT(*) FILTER (WHERE prev)::int AS prev_orders,
                COALESCE(SUM(qty) FILTER (WHERE prev), 0)::int AS prev_tickets,
                COALESCE(SUM(total) FILTER (WHERE prev), 0)::bigint AS prev_revenue
         FROM (
           SELECT ${ORDER_COUNTRY} AS country, o.currency, o.total,
                  ${ORDER_QTY} AS qty,
                  (o."paidAt" >= $3 AND o."paidAt" < $4) AS cur,
                  (o."paidAt" >= $2 AND o."paidAt" < $3) AS prev
           FROM orders o
           WHERE o."editionId" = $1 AND o.status = 'paid'
         ) x
         GROUP BY 1, 2`,
        [id, w.lastMonth, w.thisMonth, w.nextMonth],
      ),
      q<RevenueDayRow>(
        'revenue-daily',
        `SELECT currency, ${lagosDay('"paidAt"')} AS day,
                SUM(total)::bigint AS value, COUNT(*)::int AS orders
         FROM orders
         WHERE "editionId" = $1 AND status = 'paid' AND "paidAt" >= $2
         GROUP BY 1, 2`,
        [id, w.sparkFrom],
      ),
      q<PeriodRow>(
        'tiers',
        `SELECT "tierName" AS label,
                SUM(quantity)::int AS total,
                COALESCE(SUM(quantity) FILTER (WHERE "createdAt" >= $3 AND "createdAt" < $4), 0)::int AS cur,
                COALESCE(SUM(quantity) FILTER (WHERE "createdAt" >= $2 AND "createdAt" < $3), 0)::int AS prev
         FROM tickets WHERE "editionId" = $1
         GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
        [id, w.lastMonth, w.thisMonth, w.nextMonth],
      ),
      q<RecentOrderRow>(
        'recent-orders',
        `SELECT o.id, o."paidAt" AS at, o."guestName" AS buyer, o.total,
                o.currency, ${ORDER_QTY} AS tickets
         FROM orders o
         WHERE o."editionId" = $1 AND o.status = 'paid' AND o."paidAt" IS NOT NULL
         ORDER BY o."paidAt" DESC LIMIT 8`,
        [id],
      ),
      q<RecentDelegateRow>(
        'recent-delegates',
        `SELECT d.id, d.name, d."avatarUrl"
         FROM (
           SELECT "delegateId", MIN("createdAt") AS first
           FROM tickets WHERE "editionId" = $1
           GROUP BY 1 ORDER BY 2 DESC LIMIT 5
         ) h
         JOIN delegates d ON d.id = h."delegateId"
         ORDER BY h.first DESC`,
        [id],
      ),
      q<ActivityRow>(
        'activity',
        `SELECT "createdAt" AS at, "type", description, severity
         FROM "security" ORDER BY "createdAt" DESC LIMIT 8`,
        [],
      ),
      q<PeriodRow>(
        'screens',
        `SELECT props->>'path' AS label,
                COUNT(*) FILTER (WHERE "occurredAt" >= $1)::int AS cur,
                COUNT(*) FILTER (WHERE "occurredAt" < $1)::int AS prev
         FROM analytics_events
         WHERE name = 'screen_view' AND props ? 'path'
           AND "occurredAt" >= $2 AND "occurredAt" < $3
         GROUP BY 1
         HAVING COUNT(*) FILTER (WHERE "occurredAt" >= $1) > 0
         ORDER BY 2 DESC, 1 ASC LIMIT 6`,
        [w.week, w.fortnight, now],
      ),
      q<DayCountRow>(
        'active-daily',
        `SELECT ${lagosDay('"occurredAt"')} AS day,
                COUNT(DISTINCT "delegateId")::int AS count
         FROM analytics_events
         WHERE "occurredAt" >= $1 AND "occurredAt" < $2 AND "delegateId" IS NOT NULL
         GROUP BY 1`,
        [w.sparkFrom, now],
      ),
      q<EngagementDayRow>(
        'engagement-daily',
        `SELECT 'q' AS kind, ${lagosDay('sq."createdAt"')} AS day, COUNT(*)::int AS count
         FROM session_questions sq JOIN sessions s ON s.id = sq."sessionId"
         WHERE s."editionId" = $1 AND sq."createdAt" >= $2
         GROUP BY 2
         UNION ALL
         SELECT 'p', ${lagosDay('pv."createdAt"')}, COUNT(*)::int
         FROM poll_votes pv JOIN polls p ON p.id = pv."pollId"
         WHERE p."editionId" = $1 AND pv."createdAt" >= $2
         GROUP BY 2`,
        [id, w.sparkFrom],
      ),
    ]);

    const c = counts[0];
    const currency = AdminDashboardService.mainCurrency(paid);
    const main = paid.filter((r) => r.currency === currency);
    const sum = (rows: PaidRow[], k: keyof PaidRow) =>
      rows.reduce((acc, r) => acc + n(r[k]), 0);
    const compare = (current: number, previous: number): Compare => ({
      current,
      previous,
      currentLabel: w.currentLabel,
      previousLabel: w.previousLabel,
    });
    const avg = (total: number, orders: number) =>
      orders ? Math.round(total / orders) : 0;

    const curRevenue = sum(main, 'cur_revenue');
    const prevRevenue = sum(main, 'prev_revenue');

    // one row per country, whatever currencies its orders were in
    const byCountry = new Map<
      string,
      { orders: number; tickets: number; cur: number; prev: number }
    >();
    for (const r of paid) {
      const e = byCountry.get(r.country) ?? {
        orders: 0,
        tickets: 0,
        cur: 0,
        prev: 0,
      };
      e.orders += n(r.orders);
      e.tickets += n(r.tickets);
      e.cur += n(r.cur_tickets);
      e.prev += n(r.prev_tickets);
      byCountry.set(r.country, e);
    }
    const countries = [...byCountry];

    const revenueByDay = new Map<string, number>();
    let sparkOrders = 0;
    for (const r of revenueDays) {
      if (r.currency !== currency) continue;
      revenueByDay.set(r.day, (revenueByDay.get(r.day) ?? 0) + n(r.value));
      sparkOrders += n(r.orders);
    }
    const revenueDaily = w.days.map((day) => ({
      day,
      value: revenueByDay.get(day) ?? 0,
    }));

    const activeByDay = new Map(activeDays.map((r) => [r.day, n(r.count)]));
    const activeDaily = w.days.map((day) => ({
      day,
      value: activeByDay.get(day) ?? 0,
    }));

    const questionsByDay = new Map<string, number>();
    const votesByDay = new Map<string, number>();
    for (const r of engagementDays) {
      (r.kind === 'q' ? questionsByDay : votesByDay).set(r.day, n(r.count));
    }

    const holders = n(c?.holders);
    const tierRows = tiers.map((r) => ({
      label: r.label,
      value: n(r.total),
      change: changePct(n(r.cur), n(r.prev)),
    }));

    return {
      generatedAt: now.toISOString(),
      edition: {
        id: edition.id,
        name: edition.name,
        shortName: edition.shortName,
        startsAt: iso(edition.startsAt),
        endsAt: iso(edition.endsAt),
        status: edition.status,
      },
      currency,
      kpis: {
        ticketsSold: compare(
          sum(paid, 'cur_tickets'),
          sum(paid, 'prev_tickets'),
        ),
        averageOrder: compare(
          avg(curRevenue, sum(main, 'cur_orders')),
          avg(prevRevenue, sum(main, 'prev_orders')),
        ),
        revenue: compare(curRevenue, prevRevenue),
        delegates: compare(n(c?.delegates_cur), n(c?.delegates_prev)),
      },
      orderStatus: {
        paid: n(c?.paid),
        pending: n(c?.pending),
        cancelled: n(c?.cancelled),
        ticketsIssued: tierRows.reduce((acc, t) => acc + t.value, 0),
        admitted: n(c?.admitted),
        unclaimedHolders: n(c?.unclaimed),
      },
      geography: countries
        .sort(
          ([a, x], [b, y]) =>
            y.orders - x.orders || y.tickets - x.tickets || a.localeCompare(b),
        )
        .map(([code, e]) => ({
          country: code,
          name: countryName(code),
          orders: e.orders,
          tickets: e.tickets,
        })),
      tables: {
        screens: screens.map((r) => ({
          label: r.label,
          value: n(r.cur),
          change: changePct(n(r.cur), n(r.prev)),
        })),
        countries: countries
          .filter(([, e]) => e.cur > 0 || e.prev > 0)
          .sort(
            ([a, x], [b, y]) =>
              y.cur - x.cur || y.prev - x.prev || a.localeCompare(b),
          )
          .slice(0, 6)
          .map(([code, e]) => ({
            label: countryName(code),
            value: e.cur,
            change: changePct(e.cur, e.prev),
          })),
        tiers: tierRows,
      },
      spark: {
        revenue: {
          total: revenueDaily.reduce((acc, d) => acc + d.value, 0),
          paidOrders: sparkOrders,
          daily: revenueDaily,
        },
        activeDelegates: {
          today: activeDaily.at(-1)?.value ?? 0,
          // filled per request from PresenceService (withOnlineNow), not cached
          onlineNow: 0,
          daily: activeDaily,
        },
        engagement: {
          rate: holders ? Math.round((n(c?.engaged) / holders) * 1000) / 10 : 0,
          daily: w.days.map((day) => ({
            day,
            questions: questionsByDay.get(day) ?? 0,
            pollVotes: votesByDay.get(day) ?? 0,
          })),
        },
      },
      activity: activity.map((r) => ({
        at: iso(r.at),
        type: r.type,
        description: r.description,
        severity: r.severity,
      })),
      recentOrders: recentOrders.map((r) => ({
        at: iso(r.at),
        id: r.id,
        buyer: r.buyer,
        total: n(r.total),
        currency: r.currency,
        tickets: n(r.tickets),
      })),
      recentDelegates: await Promise.all(
        recentDelegates.map(async (d) => ({
          id: d.id,
          name: d.name,
          avatarUrl: await this.storage.resolveAvatar(d.avatarUrl),
        })),
      ),
    };
  }

  /**
   * The currency most paid orders used; ties go alphabetically so the
   * answer does not flip between refreshes. No paid orders: NGN.
   */
  static mainCurrency(rows: Pick<PaidRow, 'currency' | 'orders'>[]): string {
    const tally = new Map<string, number>();
    for (const r of rows) {
      tally.set(r.currency, (tally.get(r.currency) ?? 0) + n(r.orders));
    }
    const ranked = [...tally].sort(
      ([a, x], [b, y]) => y - x || a.localeCompare(b),
    );
    return ranked[0]?.[0] ?? FALLBACK_CURRENCY;
  }

  /** A Redis failure is a miss: the dashboard must render with the cache down. */
  private async readCache(key: string): Promise<DashboardView | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as DashboardView) : null;
    } catch (err) {
      this.logger.warn(`dashboard cache read failed: ${String(err)}`);
      return null;
    }
  }

  private async writeCache(key: string, view: DashboardView): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(view),
        'EX',
        DASHBOARD_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`dashboard cache write failed: ${String(err)}`);
    }
  }
}
