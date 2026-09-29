export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type PaymentMethod = 'card' | 'transfer' | 'ussd' | 'wallet';

export interface ChargeRequest {
  orderId: string;
  /** Whole units of `currency`. Always the order's own total, never a client figure. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  email: string;
  /** Billing country on the order; decides which provider takes the charge. */
  country?: string | null;
}

export interface ChargeResult {
  /** The provider's reference, shown on the receipt and used to reconcile webhooks. */
  reference: string;
  /** `paid` when the provider settled synchronously; `pending` when a webhook will confirm. */
  status: 'paid' | 'pending';
  /** A hosted checkout page to open when the provider needs the delegate to complete payment. */
  checkoutUrl?: string;
  /** Which provider actually took the charge, when the seam routes between several. */
  provider?: string;
}

/**
 * What a provider says about one charge, from a verify call or a webhook.
 * Amounts are in the currency's smallest unit (kobo, cents), as providers
 * report them, so they are compared against the order without rounding.
 */
export interface PaymentEvent {
  provider: string;
  reference: string;
  /** Our order id, when the provider carries it back (metadata, client_reference_id). */
  orderId: string | null;
  status: 'paid' | 'pending' | 'failed';
  amount: number | null;
  /** Upper case ISO code. */
  currency: string | null;
}

/** Whole units to the smallest unit. Every currency we sell in has two decimals. */
export const toMinorUnits = (amount: number): number =>
  Math.round(amount * 100);

/**
 * The seam the order lifecycle talks to. `charge` is all a provider that
 * settles on the spot needs; a router in front of hosted-checkout providers
 * also answers `verify` (ask the provider how a charge stands) and `webhook`
 * (check a callback's signature and read it).
 */
export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  verify?(provider: string, reference: string): Promise<PaymentEvent | null>;
  /**
   * Null for events that do not confirm a payment. Throws 400 on a bad
   * signature and 503 when the provider is not configured.
   */
  webhook?(
    provider: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): PaymentEvent | null;
  /** True when a provider's webhook proves only that it came from the provider, not what it says. */
  verifiesWebhooks?(provider: string): boolean;
}

/** One hosted-checkout provider (Paystack, Stripe) behind the router. */
export interface HostedCheckoutProvider {
  readonly name: string;
  /** False when its secret key is unset; the router then falls back to the log provider. */
  readonly configured: boolean;
  /** True when its webhook proves only where it came from, so events are re-verified with the API. */
  readonly verifyWebhooks?: boolean;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  verify(reference: string): Promise<PaymentEvent>;
  webhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null;
}
