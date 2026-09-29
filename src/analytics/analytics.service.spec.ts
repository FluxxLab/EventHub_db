import { BadRequestException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/**
 * The summary is five aggregations reshaped into one object. What can go
 * wrong is in the reshaping: a day with no rows vanishing from the chart, a
 * platform missing from the map, a count arriving as a string from pg, and
 * a range that runs backwards.
 */
describe('AnalyticsService.summary', () => {
  const build = (results: unknown[][]) => {
    const query = jest.fn();
    for (const r of results) query.mockResolvedValueOnce(r);
    const events = {
      insert: jest.fn().mockResolvedValue({}),
    };
    const service = new AnalyticsService(events as any, { query } as any);
    return { service, query, events };
  };

  it('aggregates the five queries into the report shape', async () => {
    const { service, query } = build([
      [{ count: '42' }],
      [
        { day: '2026-09-08', count: '10' },
        { day: '2026-09-09', count: 7 },
      ],
      [
        { path: '/schedule', views: '30' },
        { path: '/sessions/abc', views: 5 },
      ],
      [{ feature: 'captions', uses: '12' }],
      [
        { platform: 'ios', count: '30' },
        { platform: 'android', count: 12 },
      ],
    ]);

    const report = await service.summary(
      '2026-09-08T00:00:00+01:00',
      '2026-09-09T23:59:59+01:00',
    );

    expect(query).toHaveBeenCalledTimes(5);
    // every query gets the same [from, to) window
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([
        new Date('2026-09-08T00:00:00+01:00'),
        new Date('2026-09-09T23:59:59+01:00'),
      ]);
    }
    expect(report.totalEvents).toBe(42);
    expect(report.activeDelegates).toEqual([
      { day: '2026-09-08', count: 10 },
      { day: '2026-09-09', count: 7 },
    ]);
    expect(report.screens).toEqual([
      { path: '/schedule', views: 30 },
      { path: '/sessions/abc', views: 5 },
    ]);
    expect(report.features).toEqual([{ feature: 'captions', uses: 12 }]);
    // web is present at zero rather than missing
    expect(report.platforms).toEqual({ ios: 30, android: 12, web: 0 });
  });

  it('zero-fills days with no events so the chart shows the gap', async () => {
    const { service } = build([
      [{ count: 3 }],
      [{ day: '2026-09-10', count: 3 }],
      [],
      [],
      [],
    ]);
    const report = await service.summary(
      '2026-09-08T00:00:00+01:00',
      '2026-09-10T12:00:00+01:00',
    );
    expect(report.activeDelegates).toEqual([
      { day: '2026-09-08', count: 0 },
      { day: '2026-09-09', count: 0 },
      { day: '2026-09-10', count: 3 },
    ]);
  });

  it('names days in the venue zone, not UTC', () => {
    // 23:30 UTC on the 8th is already the 9th in Lagos (+01:00)
    expect(AnalyticsService.dayKey(new Date('2026-09-08T23:30:00Z'))).toBe(
      '2026-09-09',
    );
  });

  it('defaults to the last seven days', () => {
    const before = Date.now();
    const range = AnalyticsService.range();
    expect(range.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(range.to.getTime() - range.from.getTime()).toBe(7 * 86_400_000);
  });

  it('refuses a range that runs backwards', () => {
    expect(() =>
      AnalyticsService.range('2026-09-10T00:00:00Z', '2026-09-08T00:00:00Z'),
    ).toThrow(BadRequestException);
  });

  it('ignores a platform value it does not know', () => {
    expect(
      AnalyticsService.platformCounts([
        { platform: 'ios', count: 1 },
        { platform: 'blackberry', count: 9 },
      ]),
    ).toEqual({ ios: 1, android: 0, web: 0 });
  });
});

describe('AnalyticsService.ingest', () => {
  const build = () => {
    const events = {
      insert: jest.fn().mockResolvedValue({}),
    };
    const service = new AnalyticsService(events as any, {} as any);
    return { service, events };
  };

  it('writes the whole batch in one insert, stamped with the caller', async () => {
    const { service, events } = build();
    await service.ingest('d1', {
      platform: 'ios',
      appVersion: ' 1.2.0 ',
      events: [
        {
          name: 'screen_view',
          at: '2026-09-08T09:00:00+01:00',
          props: { path: '/x' },
        },
        { name: 'feature_use', at: '2026-09-08T09:01:00+01:00' },
      ],
    });
    expect(events.insert).toHaveBeenCalledTimes(1);
    const rows = events.insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      delegateId: 'd1',
      name: 'screen_view',
      platform: 'ios',
      appVersion: '1.2.0',
      props: { path: '/x' },
      occurredAt: new Date('2026-09-08T09:00:00+01:00'),
    });
    expect(rows[1].props).toEqual({});
  });

  it('refuses a props bag that is really a payload', async () => {
    const { service, events } = build();
    await expect(
      service.ingest('d1', {
        platform: 'web',
        events: [
          {
            name: 'screen_view',
            at: '2026-09-08T09:00:00Z',
            props: { blob: 'x'.repeat(3000) },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(events.insert).not.toHaveBeenCalled();
  });
});
