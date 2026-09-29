import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { paymentCallbackUrl } from './callback-url';
import {
  type ChargeRequest,
  type ChargeResult,
  type HostedCheckoutProvider,
  type PaymentEvent,
  type PaymentMethod,
  toMinorUnits,
} from './payment-provider.interface';
import { paystackSignatureValid } from './webhook-signature';

const API = 'https://api.paystack.co';

/** Paystack's channel for each method the payment screen offers. */
const CHANNELS: Record<PaymentMethod, string[]> = {
  card: ['card'],
  transfer: ['bank_transfer'],
  ussd: ['ussd'],
  wallet: ['mobile_money'],
};

interface PaystackTransaction {
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  metadata?: unknown;
}

/** Paystack returns metadata as an object, or as a JSON string when it was sent as one. */
function orderIdFrom(metadata: unknown): string | null {
  let value = metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && 'orderId' in value) {
    const id = value.orderId;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function eventFrom(tx: PaystackTransaction, reference: string): PaymentEvent {
  const status =
    tx.status === 'success'
      ? 'paid'
      : ['failed', 'abandoned', 'reversed'].includes(tx.status ?? '')
        ? 'failed'
        : 'pending';
  return {
    provider: 'paystack',
    reference: tx.reference ?? reference,
    orderId: orderIdFrom(tx.metadata),
    status,
    amount: typeof tx.amount === 'number' ? tx.amount : null,
    currency: tx.currency ? tx.currency.toUpperCase() : null,
  };
}

/**
 * Nigeria, Ghana, Kenya and South Africa. Opens a hosted checkout
 * (transaction/initialize) limited to the method the delegate picked; the
 * webhook or the app's verify call settles the order.
 */
@Injectable()
export class PaystackProvider implements HostedCheckoutProvider {
  readonly name = 'paystack';
  private readonly logger = new Logger('PaystackProvider');

  constructor(private readonly config: ConfigService) {}

  private get secret(): string | undefined {
    return this.config.get<string>('PAYSTACK_SECRET_KEY')?.trim() || undefined;
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
      status?: boolean;
      message?: string;
      data?: unknown;
    } | null;
    if (!res.ok || !body?.status) {
      this.logger.error(
        `Paystack ${path.split('/').slice(0, 3).join('/')} failed: ${res.status} ${body?.message ?? ''}`,
      );
      throw new BadGatewayException(
        'The payment provider could not be reached. Please try again.',
      );
    }
    return body.data;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    // Unique per attempt, so paying again after an abandoned checkout is a new transaction.
    const reference = `${request.orderId}-${randomBytes(4).toString('hex')}`;
    const callback = paymentCallbackUrl(this.config, {
      orderId: request.orderId,
    });
    const data = (await this.call('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: request.email,
        amount: toMinorUnits(request.amount),
        currency: request.currency,
        reference,
        callback_url: callback,
        channels: CHANNELS[request.method],
        metadata: {
          orderId: request.orderId,
          // Paystack's "cancel payment" link returns here too; verify then says not paid.
          cancel_action: callback,
        },
      }),
    })) as { authorization_url?: string; reference?: string } | undefined;
    if (!data?.authorization_url) {
      throw new BadGatewayException(
        'The payment provider could not start the checkout. Please try again.',
      );
    }
    return {
      reference: data.reference ?? reference,
      status: 'pending',
      checkoutUrl: data.authorization_url,
    };
  }

  async verify(reference: string): Promise<PaymentEvent> {
    const data = (await this.call(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    )) as PaystackTransaction | undefined;
    return eventFrom(data ?? {}, reference);
  }

  webhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    const secret = this.secret;
    if (!secret) {
      throw new ServiceUnavailableException('Paystack is not configured');
    }
    if (!paystackSignatureValid(rawBody, signature, secret)) {
      throw new BadRequestException('Invalid signature');
    }
    let event: { event?: string; data?: PaystackTransaction };
    try {
      event = JSON.parse(rawBody.toString('utf8')) as typeof event;
    } catch {
      throw new BadRequestException('Invalid payload');
    }
    if (event.event !== 'charge.success' || !event.data?.reference) return null;
    return eventFrom(event.data, event.data.reference);
  }
}
