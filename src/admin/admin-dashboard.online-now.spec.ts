import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { StorageService } from '../common/storage/storage.service';
import type { PresenceService } from '../delegate/presence.service';
import type { EditionsService } from '../editions/editions.service';
import { AdminDashboardService } from './admin-dashboard.service';

/**
 * "Online now" comes from presence on every request, laid over the 30 s
 * cached view rather than cached with it.
 */
describe('AdminDashboardService online now', () => {
  const build = (cached: string | null, online = 42) => {
    const redis = {
      get: jest.fn().mockResolvedValue(cached),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const presence = { onlineCount: jest.fn().mockResolvedValue(online) };
    const service = new AdminDashboardService(
      { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      {
        current: jest.fn().mockResolvedValue(null),
        findById: jest.fn(),
      } as unknown as EditionsService,
      {} as StorageService,
      redis as unknown as Redis,
      presence as unknown as PresenceService,
    );
    return { service, redis, presence };
  };

  it('fills onlineNow from the global online count', async () => {
    const { service } = build(null, 42);
    const view = await service.dashboard();
    expect(view.spark.activeDelegates.onlineNow).toBe(42);
  });

  it('never caches the live count, and refreshes it over a cached view', async () => {
    const fresh = build(null, 7);
    await fresh.service.dashboard();
    const stored = JSON.parse(
      (fresh.redis.set.mock.calls[0] as [string, string])[1],
    ) as ReturnType<typeof AdminDashboardService.empty>;
    expect(stored.spark.activeDelegates.onlineNow).toBe(0);

    const cached = build(JSON.stringify(stored), 9);
    const view = await cached.service.dashboard();
    expect(view.spark.activeDelegates.onlineNow).toBe(9);
    expect(cached.redis.set).not.toHaveBeenCalled();
  });
});
