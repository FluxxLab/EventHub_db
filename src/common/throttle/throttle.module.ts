import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { isSignedIn } from './app-throttler.guard';

/** Default budget per signed-in user, per route, per minute. */
export const DEFAULT_USER_LIMIT = 120;
/**
 * Default budget per IP for anonymous callers. Higher than the per-user one
 * on purpose: at the venue hundreds of phones share one NAT address before
 * they sign in, and they must not exhaust each other's budget.
 */
export const DEFAULT_ANON_LIMIT = 600;

/**
 * Rate limiting, counted in Redis so the budget is shared by every API
 * instance rather than multiplied by them. Routes tighten it with the
 * decorators in throttle.decorators.ts; AppThrottlerGuard (an APP_GUARD in
 * AppModule) applies it. Buckets are per route: @nestjs/throttler keys them
 * by controller and handler as well as by tracker.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS],
      useFactory: (config: ConfigService, redis: Redis) => {
        const userLimit =
          config.get<number>('THROTTLE_LIMIT') ?? DEFAULT_USER_LIMIT;
        const anonLimit =
          config.get<number>('THROTTLE_ANON_LIMIT') ?? DEFAULT_ANON_LIMIT;
        return {
          throttlers: [
            {
              name: 'default',
              ttl: 60_000,
              limit: (context) => (isSignedIn(context) ? userLimit : anonLimit),
            },
          ],
          // shares the app's connection; the storage leaves a passed-in client open
          storage: new ThrottlerStorageRedisService(redis),
        };
      },
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottleModule {}
