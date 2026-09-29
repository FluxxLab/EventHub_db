import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'crypto';
import { paymentCallbackUrl } from './callback-url';
import {
  type ChargeRequest,
  type ChargeResult,
  type HostedCheckoutProvider,
  type PaymentEvent,
  type PaymentMethod,
  toMinorUnits,
} from './payment-provider.interface';

const API = 'https://api.flutterwave.com/v3';

/** Flutterwave's mobile-money option for each currency that has one. */
const MOBILE_MONEY: Record<string, string> = {
  GHS: 'mobilemoneyghana',
  KES: 'mpesa',
  UGX: 'mobilemoneyuganda',
  RWF: 'mobilemoneyrwanda',
  ZMW: 'mobilemoneyzambia',
  XAF: 'mobilemoneyfranco',
  XOF: 'mobilemoneyfranco',
  TZS: 'mobilemoneytanzania',
};

/** The checkout options for the method the delegate picked on the payment screen. */
export function flutterwaveOptions(
  method: PaymentMethod,
  currency: string,
): string {
  switch (method) {
    case 'card':
      return 'card';
    case 'transfer':
      return 'banktransfer';
    case 'ussd':
      return 'ussd';
    case 'wallet':
      return MOBILE_MONEY[currency.toUpperCase()] ?? 'card';
  }
}

/** Our order id is the first 36 characters of every tx_ref we create. */
export function orderIdFromTxRef(txRef: string | undefined): string | null {
  const match = txRef
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(
        txRef,
      )
    : null;
  return match ? match[0].toLowerCase() : null;
}

interface FlutterwaveTransaction {
  status?: string;
  tx_ref?: string;
  /** Major units (naira, cedis), unlike Paystack and Stripe. */
  amount?: number;
  currency?: string;
}

function eventFrom(
  tx: FlutterwaveTransaction,
  reference: string,
): PaymentEvent {
  const status =
    tx.status === 'successful'
      ? 'paid'
      : tx.status === 'failed' || tx.status === 'cancelled'
        ? 'failed'
        : 'pending';
  const txRef = tx.tx_ref ?? reference;
  return {
    provider: 'flutterwave',
    reference: txRef,
    orderId: orderIdFromTxRef(txRef),
    status,
    // Compared against the order in the smallest unit, like every other provider.
    amount: typeof tx.amount === 'number' ? toMinorUnits(tx.amount) : null,
    currency: tx.currency ? tx.currency.toUpperCase() : null,
  };
}

/**
 * Flutterwave Standard: a hosted checkout for every billing country (naira,
 * cedis, shillings, rand, dollars), limited to the method the delegate
 * picked. The redirect back, the app's verify call or the webhook settles the
 * order, always after asking Flutterwave how the transaction stands: the
 * webhook's `verif-hash` is a shared secret, not a signature over the body,
 * so its contents are never trusted on their own.
 */
@Injectable()
export class FlutterwaveProvider implements HostedCheckoutProvider {
  readonly name = 'flutterwave';
  /** Webhook events are re-verified with the API before anything is settled. */
  readonly verifyWebhooks = true;
  private readonly logger = new Logger('FlutterwaveProvider');

  constructor(private readonly config: ConfigService) {}

  private get secret(): string | undefined {
    return (
      this.config.get<string>('FLUTTERWAVE_SECRET_KEY')?.trim() || undefined
    );
  }

  private get webhookHash(): string | undefined {
    return (
      this.config.get<string>('FLUTTERWAVE_WEBHOOK_HASH')?.trim() || undefined
    );
  }

  get configured(): boolean {
    return !!this.secret;
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
    });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      message?: string;
      data?: unknown;
    } | null;
    if (!res.ok || body?.status !== 'success') {
      this.logger.error(
        `Flutterwave ${path.split('?')[0]} failed: ${res.status} ${body?.message ?? ''}`,
      );
      throw new BadGatewayException(
        'The payment provider could not be reached. Please try again.',
      );
    }
    return body.data;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    // Unique per attempt, so paying again after an abandoned checkout is a new transaction.
    const txRef = `${request.orderId}-${randomBytes(4).toString('hex')}`;
    const data = (await this.call('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: txRef,
        // Flutterwave takes major units.
        amount: request.amount,
        currency: request.currency.toUpperCase(),
        redirect_url: paymentCallbackUrl(this.config, {
          orderId: request.orderId,
        }),
        payment_options: flutterwaveOptions(request.method, request.currency),
        customer: { email: request.email },
        meta: { orderId: request.orderId },
        customizations: { title: 'PIC Events' },
        // A checkout left open all day should not settle tomorrow at today's price.
        session_duration: 60,
      }),
    })) as { link?: string } | undefined;
    if (!data?.link) {
      throw new BadGatewayException(
        'The payment provider could not start the checkout. Please try again.',
      );
    }
    return { reference: txRef, status: 'pending', checkoutUrl: data.link };
  }

  async verify(reference: string): Promise<PaymentEvent> {
    try {
      const data = (await this.call(
        `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      )) as FlutterwaveTransaction | undefined;
      return eventFrom(data ?? {}, reference);
    } catch (error) {
      // No transaction yet for this tx_ref (checkout opened, nothing paid) is "not paid", not an outage.
      if (error instanceof BadGatewayException) {
        return {
          provider: 'flutterwave',
          reference,
          orderId: orderIdFromTxRef(reference),
          status: 'pending',
          amount: null,
          currency: null,
        };
      }
      throw error;
    }
  }

  webhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    const hash = this.webhookHash;
    if (!this.secret || !hash) {
      throw new ServiceUnavailableException('Flutterwave is not configured');
    }
    const given = Buffer.from(signature ?? '', 'utf8');
    const expected = Buffer.from(hash, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BadRequestException('Invalid signature');
    }
    let event: { event?: string; data?: FlutterwaveTransaction };
    try {
      event = JSON.parse(rawBody.toString('utf8')) as typeof event;
    } catch {
      throw new BadRequestException('Invalid payload');
    }
    if (event.event !== 'charge.completed' || !event.data?.tx_ref) return null;
    return eventFrom(event.data, event.data.tx_ref);
  }
}
