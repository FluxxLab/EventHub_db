import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { EditionsService } from '../editions/editions.service';
import {
  AdminDashboardService,
  changePct,
  dashboardCacheKey,
  dashboardWindows,
  DASHBOARD_CACHE_TTL_SECONDS,
} from './admin-dashboard.service';

/**
 * The dashboard is ten aggregate queries reshaped into one view. The risks
 * are in the reshaping: the wrong currency picked as "main", month labels
 * off by one at the Lagos/UTC boundary, a percentage against zero, days with
 * no rows vanishing from a sparkline, and the cache not being used.
 */
describe('AdminDashboardService', () => {
  const NOW = new Date('2026-09-24T10:00:00Z'); // 11:00 in Lagos
  const EDITION = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Gender & Inclusion Summit 2026',
    shortName: 'GS-26',
    startsAt: new Date('2026-10-12T08:00:00Z'),
    endsAt: new Date('2026-10-14T17:00:00Z'),
    status: 'published',
  };

  /** Rows per query, routed by the `/* dashboard:<tag> *\/` marker. */
  type Results = Partial<Record<string, unknown[]>>;

  const build = (
    results: Results = {},
    opts: { edition?: unknown; cached?: string | null } = {},
  ) => {
    const query = jest.fn((sql: string) => {
      const tag = /\/\* dashboard:([a-z-]+) \*\//.exec(sql)?.[1] ?? '';
      return Promise.resolve(results[tag] ?? []);
    });
    const editions = {
      current: jest
        .fn()
        .mockResolvedValue(opts.edition === undefined ? EDITION : opts.edition),
      findById: jest.fn().mockResolvedValue(EDITION),
    };
    const storage = {
      resolveAvatar: jest.fn((v: string | null) =>
        Promise.resolve(v ? `https://signed/${v}` : null),
      ),
    };
    const redis = {
      get: jest.fn().mockResolvedValue(opts.cached ?? null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const service = new AdminDashboardService(
      { query } as unknown as DataSource,
      editions as unknown as EditionsService,
      storage as unknown as StorageService,
      redis as unknown as Redis,
    );
    return { service, query, editions, storage, redis };
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('renders an empty view, not a 404, when there is no edition', async () => {
    const { service, query, redis } = build({}, { edition: null });
    const view = await service.dashboard();

    expect(query).not.toHaveBeenCalled();
    expect(view.edition).toBeNull();
    expect(view.currency).toBe('NGN');
    expect(view.kpis.revenue).toEqual({
      current: 0,
      previous: 0,
      currentLabel: 'Sep 2026',
      previousLabel: 'Aug 2026',
    });
    expect(view.orderStatus).toEqual({
      paid: 0,
      pending: 0,
      cancelled: 0,
      ticketsIssued: 0,
      admitted: 0,
      unclaimedHolders: 0,
    });
    expect(view.geography).toEqual([]);
    expect(view.tables).toEqual({ screens: [], countries: [], tiers: [] });
    expect(view.spark.revenue.daily).toHaveLength(14);
    expect(view.spark.revenue.daily.every((d) => d.value === 0)).toBe(true);
    expect(view.recentOrders).toEqual([]);
    expect(redis.set).toHaveBeenCalledWith(
      dashboardCacheKey('none'),
      expect.any(String),
      'EX',
      DASHBOARD_CACHE_TTL_SECONDS,
    );
  });

  it('renders zeros for an edition with no data yet', async () => {
    const { service, query } = build();
    const view = await service.dashboard();

    expect(query).toHaveBeenCalledTimes(10);
    expect(view.edition).toEqual({
      id: EDITION.id,
      name: EDITION.name,
      shortName: 'GS-26',
      startsAt: '2026-10-12T08:00:00.000Z',
      endsAt: '2026-10-14T17:00:00.000Z',
      status: 'published',
    });
    expect(view.currency).toBe('NGN');
    expect(view.kpis.ticketsSold.current).toBe(0);
    expect(view.kpis.averageOrder).toMatchObject({ current: 0, previous: 0 });
    expect(view.spark.engagement.rate).toBe(0);
    expect(view.spark.activeDelegates).toMatchObject({
      today: 0,
      onlineNow: 0,
    });
    expect(view.recentDelegates).toEqual([]);
  });

  it('picks the currency most paid orders used and keeps money figures in it', async () => {
    const paid = (
      country: string,
      currency: string,
      o: Partial<Record<string, number | string>>,
    ) => ({
      country,
      currency,
      orders: 0,
      tickets: 0,
      cur_orders: 0,
      cur_tickets: 0,
      cur_revenue: 0,
      prev_orders: 0,
      prev_tickets: 0,
      prev_revenue: 0,
      ...o,
    });
    const { service } = build({
      paid: [
        // NGN: 3 paid orders; USD: 2 but far more money - orders decide
        paid('NG', 'NGN', {
          orders: 3,
          tickets: '5',
          cur_orders: 2,
          cur_tickets: 3,
          cur_revenue: '150000',
          prev_orders: 1,
          prev_tickets: 2,
          prev_revenue: '100000',
        }),
        paid('US', 'USD', {
          orders: 2,
          tickets: 4,
          cur_orders: 2,
          cur_tickets: 4,
          cur_revenue: 900,
        }),
      ],
      'revenue-daily': [
        { currency: 'NGN', day: '2026-09-20', value: '50000', orders: 1 },
        { currency: 'NGN', day: '2026-09-24', value: 100000, orders: 1 },
        { currency: 'USD', day: '2026-09-24', value: 900, orders: 2 },
      ],
    });
    const view = await service.dashboard();

    expect(view.currency).toBe('NGN');
    // tickets are tickets whatever they were paid in
    expect(view.kpis.ticketsSold).toMatchObject({ current: 7, previous: 2 });
    // money is main currency only
    expect(view.kpis.revenue).toMatchObject({
      current: 150000,
      previous: 100000,
    });
    expect(view.kpis.averageOrder).toMatchObject({
      current: 75000,
      previous: 100000,
    });
    expect(view.spark.revenue.total).toBe(150000);
    expect(view.spark.revenue.paidOrders).toBe(2);
    // most orders first
    expect(view.geography).toEqual([
      { country: 'NG', name: 'Nigeria', orders: 3, tickets: 5 },
      { country: 'US', name: 'United States', orders: 2, tickets: 4 },
    ]);
    expect(view.tables.countries).toEqual([
      { label: 'United States', value: 4, change: null },
      { label: 'Nigeria', value: 3, change: 50 },
    ]);
  });

  it('breaks a currency tie alphabetically and defaults to NGN', () => {
    expect(
      AdminDashboardService.mainCurrency([
        { currency: 'USD', orders: 2 },
        { currency: 'GHS', orders: '2' },
      ]),
    ).toBe('GHS');
    expect(AdminDashboardService.mainCurrency([])).toBe('NGN');
  });

  describe('month windows (Africa/Lagos)', () => {
    it('labels this month and last month', () => {
      const w = dashboardWindows(NOW);
      expect(w.currentLabel).toBe('Sep 2026');
      expect(w.previousLabel).toBe('Aug 2026');
      // Lagos is UTC+1: the month starts an hour before UTC midnight
      expect(w.thisMonth.toISOString()).toBe('2026-08-31T23:00:00.000Z');
      expect(w.lastMonth.toISOString()).toBe('2026-07-31T23:00:00.000Z');
      expect(w.nextMonth.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    });

    it('is already next month in Lagos at 23:30 UTC on the last day', () => {
      const w = dashboardWindows(new Date('2026-09-30T23:30:00Z'));
      expect(w.currentLabel).toBe('Oct 2026');
      expect(w.previousLabel).toBe('Sep 2026');
    });

    it('rolls back across a year boundary', () => {
      const w = dashboardWindows(new Date('2027-01-05T12:00:00Z'));
      expect(w.currentLabel).toBe('Jan 2027');
      expect(w.previousLabel).toBe('Dec 2026');
      expect(w.lastMonth.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    });

    it('puts the labels on every KPI', async () => {
      const { service } = build();
      const { kpis } = await service.dashboard();
      for (const k of Object.values(kpis)) {
        expect(k.currentLabel).toBe('Sep 2026');
        expect(k.previousLabel).toBe('Aug 2026');
      }
    });
  });

  describe('change %', () => {
    it('is one decimal, and null when the previous period is 0', () => {
      expect(changePct(3, 2)).toBe(50);
      expect(changePct(1, 3)).toBe(-66.7);
      expect(changePct(5, 0)).toBeNull();
      expect(changePct(0, 0)).toBeNull();
      expect(changePct(0, 4)).toBe(-100);
    });

    it('applies to screens and tiers', async () => {
      const { service } = build({
        screens: [
          { label: '/schedule', cur: '30', prev: '20' },
          { label: '/trivia', cur: 4, prev: 0 },
        ],
        tiers: [
          { label: 'Standard', total: '120', cur: 10, prev: 8 },
          { label: 'VIP', total: 12, cur: 2, prev: 0 },
        ],
      });
      const view = await service.dashboard();
      expect(view.tables.screens).toEqual([
        { label: '/schedule', value: 30, change: 50 },
        { label: '/trivia', value: 4, change: null },
      ]);
      expect(view.tables.tiers).toEqual([
        { label: 'Standard', value: 120, change: 25 },
        { label: 'VIP', value: 12, change: null },
      ]);
      expect(view.orderStatus.ticketsIssued).toBe(132);
    });
  });

  it('zero-fills the 14-day series in Lagos days, ending today', async () => {
    const { service } = build({
      'active-daily': [
        { day: '2026-09-12', count: '3' },
        { day: '2026-09-24', count: 9 },
      ],
      'engagement-daily': [
        { kind: 'q', day: '2026-09-23', count: 4 },
        { kind: 'p', day: '2026-09-23', count: '6' },
        { kind: 'p', day: '2026-09-24', count: 1 },
      ],
      'revenue-daily': [
        { currency: 'NGN', day: '2026-09-15', value: 2500, orders: 1 },
      ],
    });
    const view = await service.dashboard();

    const days = view.spark.activeDelegates.daily.map((d) => d.day);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-09-11');
    expect(days[13]).toBe('2026-09-24');
    expect(view.spark.activeDelegates.daily[1]).toEqual({
      day: '2026-09-12',
      value: 3,
    });
    expect(view.spark.activeDelegates.daily[2].value).toBe(0);
    expect(view.spark.activeDelegates.today).toBe(9);
    expect(view.spark.revenue.daily.map((d) => d.day)).toEqual(days);
    expect(view.spark.revenue.daily[4]).toEqual({
      day: '2026-09-15',
      value: 2500,
    });
    expect(view.spark.engagement.daily.slice(-2)).toEqual([
      { day: '2026-09-23', questions: 4, pollVotes: 6 },
      { day: '2026-09-24', questions: 0, pollVotes: 1 },
    ]);
    expect(view.spark.engagement.daily[0]).toEqual({
      day: '2026-09-11',
      questions: 0,
      pollVotes: 0,
    });
  });

  it('reads counts, engagement rate, recent lists and signs avatars', async () => {
    const { service, storage } = build({
      counts: [
        {
          paid: 5,
          pending: '2',
          cancelled: 1,
          admitted: 40,
          holders: 3,
          unclaimed: 1,
          engaged: 2,
          delegates_cur: 2,
          delegates_prev: 1,
        },
      ],
      'recent-orders': [
        {
          id: 'o1',
          at: new Date('2026-09-24T09:00:00Z'),
          buyer: 'Ada Obi',
          total: '75000',
          currency: 'NGN',
          tickets: 2,
        },
      ],
      'recent-delegates': [
        { id: 'd1', name: 'Ada Obi', avatarUrl: 'avatars/d1.jpg' },
        { id: 'd2', name: 'Kofi Mensah', avatarUrl: null },
      ],
      activity: [
        {
          at: '2026-09-24T08:00:00.000Z',
          type: 'login_failed',
          description: 'Five failed sign-ins',
          severity: 'warning',
        },
      ],
    });
    const view = await service.dashboard();

    expect(view.orderStatus).toMatchObject({
      paid: 5,
      pending: 2,
      cancelled: 1,
      admitted: 40,
      unclaimedHolders: 1,
    });
    expect(view.kpis.delegates).toMatchObject({ current: 2, previous: 1 });
    expect(view.spark.engagement.rate).toBe(66.7);
    expect(view.recentOrders).toEqual([
      {
        at: '2026-09-24T09:00:00.000Z',
        id: 'o1',
        buyer: 'Ada Obi',
        total: 75000,
        currency: 'NGN',
        tickets: 2,
      },
    ]);
    expect(view.recentDelegates).toEqual([
      { id: 'd1', name: 'Ada Obi', avatarUrl: 'https://signed/avatars/d1.jpg' },
      { id: 'd2', name: 'Kofi Mensah', avatarUrl: null },
    ]);
    expect(storage.resolveAvatar).toHaveBeenCalledTimes(2);
    expect(view.activity[0]).toMatchObject({ severity: 'warning' });
  });

  it('passes the edition and month boundaries to the queries', async () => {
    const { service, query } = build();
    await service.dashboard();
    const counts = query.mock.calls.find(([sql]) =>
      sql.includes('dashboard:counts'),
    ) as unknown as [string, unknown[]];
    expect(counts[1]).toEqual([
      EDITION.id,
      new Date('2026-07-31T23:00:00Z'),
      new Date('2026-08-31T23:00:00Z'),
      new Date('2026-09-30T23:00:00Z'),
      'ticket-holder',
    ]);
  });

  describe('caching', () => {
    it('serves a cached view without querying', async () => {
      const cached = JSON.stringify({ generatedAt: 'cached', edition: null });
      const { service, query, redis } = build({}, { cached });
      const view = await service.dashboard();
      expect(view).toEqual({ generatedAt: 'cached', edition: null });
      expect(redis.get).toHaveBeenCalledWith(dashboardCacheKey(EDITION.id));
      expect(query).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('caches a fresh build per edition for 30 s', async () => {
      const { service, redis } = build();
      const view = await service.dashboard();
      expect(redis.set).toHaveBeenCalledWith(
        `admin:dashboard:${EDITION.id}`,
        JSON.stringify(view),
        'EX',
        30,
      );
    });

    it('uses the given edition, not the current one', async () => {
      const { service, editions, redis } = build();
      await service.dashboard(EDITION.id);
      expect(editions.findById).toHaveBeenCalledWith(EDITION.id);
      expect(editions.current).not.toHaveBeenCalled();
      expect(redis.get).toHaveBeenCalledWith(dashboardCacheKey(EDITION.id));
    });

    it('still renders when Redis is down', async () => {
      const { service, redis } = build();
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const view = await service.dashboard();
      expect(view.edition?.id).toBe(EDITION.id);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});
