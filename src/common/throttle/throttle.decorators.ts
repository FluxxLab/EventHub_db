import { createHash } from 'node:crypto';
import { Throttle, normalizeIp } from '@nestjs/throttler';
import type { Request } from 'express';

const MINUTE = 60_000;

/** The client IP as Express resolved it behind the proxy ('trust proxy' in main.ts). */
export function clientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

/**
 * Tracker for the credential routes: the IP *and* the account being tried.
 *
 * IP alone is wrong at the summit: the venue wifi sits behind one or two
 * NAT addresses, so a per-IP 10/min would lock every delegate out of login
 * after the first ten. IP plus the submitted email still stops one client
 * hammering one account, which is the attack these limits exist for.
 */
export function credentialTracker(req: Request): string {
  const body = (req.body ?? {}) as { email?: unknown };
  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  return email ? `ip:${clientIp(req)}|acct:${email}` : `ip:${clientIp(req)}`;
}

/**
 * Tracker for token refresh: the refresh token itself (hashed, never kept in
 * the clear), so the venue's shared IP is not one bucket for every phone.
 */
export function refreshTracker(req: Request): string {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== 'string' || !body.refreshToken)
    return `ip:${clientIp(req)}`;
  const digest = createHash('sha256')
    .update(body.refreshToken)
    .digest('hex')
    .slice(0, 32);
  return `refresh:${digest}`;
}

/** login / register / OTP / forgot / reset: 10 a minute per IP and account. */
export const ThrottleCredentials = () =>
  Throttle({
    default: { limit: 10, ttl: MINUTE, getTracker: credentialTracker },
  });

/** Token refresh: the default budget, bucketed per refresh token. */
export const ThrottleRefresh = () =>
  Throttle({ default: { getTracker: refreshTracker } });

/** Direct messages: 30 a minute per sender. */
export const ThrottleMessages = () =>
  Throttle({ default: { limit: 30, ttl: MINUTE } });

/** Search and the delegate directory: 60 a minute per user. */
export const ThrottleLookup = () =>
  Throttle({ default: { limit: 60, ttl: MINUTE } });

/** Votes, trivia answers, upvotes: 30 a minute per user. */
export const ThrottleVote = () =>
  Throttle({ default: { limit: 30, ttl: MINUTE } });

/**
 * Tracker for exhibitor scanners: the stand's key (hashed), so every stand
 * on the venue's shared IP gets its own budget, and an unkeyed caller shares
 * one with its IP.
 */
export function boothKeyTracker(req: Request): string {
  const key = req.headers['x-booth-key'];
  if (typeof key !== 'string' || !key) return `ip:${clientIp(req)}`;
  return `booth:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Tracker for food-counter scanners: the counter's key (hashed), like the stands'. */
export function counterKeyTracker(req: Request): string {
  const key = req.headers['x-counter-key'];
  if (typeof key !== 'string' || !key) return `ip:${clientIp(req)}`;
  return `counter:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Food counters: 120 scans a minute per counter, enough for a fast lunch queue. */
export const ThrottleMealCounter = () =>
  Throttle({
    default: { limit: 120, ttl: MINUTE, getTracker: counterKeyTracker },
  });

/** Exhibitor lead scanning: 120 a minute per stand, a scan every half second. */
export const ThrottleBoothScanner = () =>
  Throttle({
    default: { limit: 120, ttl: MINUTE, getTracker: boothKeyTracker },
  });
