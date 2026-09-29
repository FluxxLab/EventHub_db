import { createHmac, timingSafeEqual } from 'crypto';

const sameHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Paystack: `x-paystack-signature` is the hex HMAC-SHA512 of the raw body, keyed with the secret key. */
export function paystackSignatureValid(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  return sameHex(expected, signature.trim().toLowerCase());
}

/** How old a Stripe signature may be before it counts as a replay. */
export const STRIPE_TOLERANCE_SEC = 300;

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`. Valid when any v1 is
 * the hex HMAC-SHA256 of `${t}.${rawBody}` keyed with the endpoint secret, and
 * `t` is within the tolerance of now.
 */
export function stripeSignatureValid(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = STRIPE_TOLERANCE_SEC,
): boolean {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value.toLowerCase());
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return signatures.some((s) => sameHex(expected, s));
}
