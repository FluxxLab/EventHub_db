import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Request } from 'express';
import { AppThrottlerGuard, isSignedIn } from './app-throttler.guard';
import { credentialTracker, refreshTracker } from './throttle.decorators';

const jwt = new JwtService({ secret: 'test-secret' });

function http(req: Partial<Request> & Record<string, unknown>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** Exposes the protected hooks without running the storage. */
class TestGuard extends AppThrottlerGuard {
  tracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
  skip(context: ExecutionContext) {
    return this.shouldSkip(context);
  }
  identify(context: ExecutionContext) {
    // canActivate's first step, without the storage round trip
    return (
      this as unknown as {
        resolveUser: (r: unknown) => Promise<string | null>;
      }
    ).resolveUser(context.switchToHttp().getRequest());
  }
}

const guard = new TestGuard(
  { throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] },
  {} as ThrottlerStorage,
  new Reflector(),
  jwt,
);

describe('AppThrottlerGuard', () => {
  it('skips payment webhooks and the health root, not ordinary routes', async () => {
    const at = (url: string) => http({ originalUrl: url, url });
    expect(await guard.skip(at('/api/v1/payments/paystack/webhook'))).toBe(
      true,
    );
    expect(await guard.skip(at('/api/v1/health'))).toBe(true);
    expect(await guard.skip(at('/api/v1'))).toBe(true);
    expect(await guard.skip(at('/api/v1/auth/login'))).toBe(false);
    expect(await guard.skip(at('/api/v1/polls/p1/vote'))).toBe(false);
  });

  it('counts a signed-in delegate by user id, not by the shared venue IP', async () => {
    const token = await jwt.signAsync({ sub: 'd1', role: 'standard' });
    const req = {
      ip: '41.0.0.1',
      headers: { authorization: `Bearer ${token}` },
    };
    expect(await guard.identify(http(req))).toBe('d1');
  });

  it('ignores a forged or refresh token and falls back to the IP', async () => {
    const forged = await new JwtService({ secret: 'other' }).signAsync({
      sub: 'x',
    });
    const refresh = await jwt.signAsync({ sub: 'd1', typ: 'refresh' });
    for (const token of [forged, refresh, 'garbage']) {
      const req = {
        ip: '41.0.0.1',
        headers: { authorization: `Bearer ${token}` },
      };
      expect(await guard.identify(http(req))).toBeNull();
    }
    expect(await guard.tracker({ ip: '41.0.0.1', headers: {} })).toBe(
      'ip:41.0.0.1',
    );
  });

  it('applies the signed-in limit once the caller is identified', () => {
    const req: Record<string | symbol, unknown> = {
      ip: '41.0.0.1',
      headers: {},
      user: { id: 'd9' },
    };
    const ctx = http(req as Partial<Request>);
    expect(isSignedIn(ctx)).toBe(true);
    expect(isSignedIn(http({ ip: '1.1.1.1', headers: {} }))).toBe(false);
  });
});

describe('credential and refresh trackers', () => {
  it('buckets login attempts per IP and account, so one NAT address is not one bucket', () => {
    const a = credentialTracker({
      ip: '41.0.0.1',
      body: { email: 'Ada@Example.org ' },
    } as Request);
    const b = credentialTracker({
      ip: '41.0.0.1',
      body: { email: 'grace@example.org' },
    } as Request);
    expect(a).toBe('ip:41.0.0.1|acct:ada@example.org');
    expect(a).not.toBe(b);
  });

  it('buckets refreshes per token without keeping the token', () => {
    const t = refreshTracker({
      ip: '41.0.0.1',
      body: { refreshToken: 'secret-token' },
    } as Request);
    expect(t).toMatch(/^refresh:[0-9a-f]{32}$/);
    expect(t).not.toContain('secret-token');
  });
});
