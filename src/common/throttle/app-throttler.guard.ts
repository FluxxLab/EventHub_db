import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { clientIp } from './throttle.decorators';

/** Set on the request before any limit is resolved; see `canActivate`. */
export const THROTTLE_USER = Symbol('throttleUser');

type ThrottledRequest = Request & {
  user?: { id?: string };
  [THROTTLE_USER]?: string | null;
};

/** Never rate limited: payment providers and LiveKit retry on 429, and health checks must answer. */
const SKIPPED_PATHS = [
  /\/payments\/[^/]+\/webhook\/?$/,
  /\/livekit\/webhook\/?$/,
  /\/health\/?$/,
  // campaign open images and click redirects: mail providers fetch them from
  // a few shared addresses (Gmail's image proxy), and only signed ones write
  /\/email\/[oc]\/[^/]+$/,
  // the root GET that load balancer and uptime checks hit
  /^\/(api(\/v\d+)?)?\/?$/,
];

/**
 * The global rate limiter: per signed-in user, falling back to IP.
 *
 * Runs after JwtAuthGuard (APP_GUARD order in AppModule), so protected
 * routes already carry `req.user`. Public routes skip passport, so a bearer
 * token there is verified here - otherwise a delegate reading the programme
 * would be counted by the venue's shared NAT address with everyone else.
 * An unverifiable token is ignored, never trusted, so a forged `sub` cannot
 * spread one client over many buckets.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storage, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<ThrottledRequest>();
      req[THROTTLE_USER] = await this.resolveUser(req);
    }
    return super.canActivate(context);
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return Promise.resolve(true);
    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    return Promise.resolve(SKIPPED_PATHS.some((re) => re.test(path)));
  }

  protected override getTracker(req: Record<string, any>): Promise<string> {
    const user = (req as ThrottledRequest)[THROTTLE_USER];
    return Promise.resolve(
      user ? `user:${user}` : `ip:${clientIp(req as Request)}`,
    );
  }

  private async resolveUser(req: ThrottledRequest): Promise<string | null> {
    if (req.user?.id) return req.user.id;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: string;
        typ?: string;
      }>(header.slice(7));
      // refresh and pass tokens carry `typ`; only access tokens identify a caller
      return payload.sub && !payload.typ ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

/** Whether the request was identified as a signed-in user (for the default limit). */
export function isSignedIn(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  const req = context.switchToHttp().getRequest<ThrottledRequest>();
  return Boolean(req[THROTTLE_USER] ?? req.user?.id);
}
