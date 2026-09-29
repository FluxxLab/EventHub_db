import type { ConfigService } from '@nestjs/config';

/** Where a hosted checkout sends the delegate back to: the app's deep link unless configured. */
export const DEFAULT_PAYMENT_CALLBACK_URL = 'picevents://payment/return';

export function paymentCallbackUrl(
  config: ConfigService,
  params: Record<string, string>,
): string {
  const base =
    config.get<string>('PAYMENT_CALLBACK_URL')?.trim() ||
    DEFAULT_PAYMENT_CALLBACK_URL;
  // String joining rather than URL: a custom scheme like picevents:// is not
  // something every URL parser round-trips faithfully.
  const query = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}
