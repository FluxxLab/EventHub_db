import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { paymentCallbackUrl } from './callback-url';
import {
  type ChargeRequest,
  type ChargeResult,
  type HostedCheckoutProvider,
  type PaymentEvent,
  toMinorUnits,
} from './payment-provider.interface';
import { stripeSignatureValid } from './webhook-signature';

const API = 'https://api.stripe.com/v1';

interface CheckoutSession {
  id?: string;
  url?: string | null;
  status?: string;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
}

function eventFrom(session: CheckoutSession, reference: string): PaymentEvent {
  const status =
    session.payment_status === 'paid'
      ? 'paid'
      : session.status === 'expired'
        ? 'failed'
        : 'pending';
  return {
    provider: 'stripe',
    reference: session.id ?? reference,
    orderId: session.client_reference_id ?? null,
    status,
    amount:
      typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency ? session.currency.toUpperCase() : null,
  };
}

/**
 * Everyone paying in dollars. A Stripe Checkout Session with one line for
 * the order total, over the REST API (form-encoded) so there is no SDK to
 * keep in step. The webhook or the app's verify call settles the order.
 */
@Injectable()
export class StripeProvider implements HostedCheckoutProvider {
  readonly name = 'stripe';
  private readonly logger = new Logger('StripeProvider');

  constructor(private readonly config: ConfigService) {}

  private get secret(): string | undefined {
    return this.config.get<string>('STRIPE_SECRET_KEY')?.trim() || undefined;
  }

  get configured(): boolean {
    return !!this.secret;
  }

  private async call(
    path: string,
    form?: URLSearchParams,
  ): Promise<CheckoutSession> {
    const res = await fetch(`${API}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: form?.toString(),
    });
    const body = (await res.json().catch(() => null)) as
      (CheckoutSession & { error?: { message?: string } }) | null;
    if (!res.ok || !body) {
      this.logger.error(
        `Stripe ${path.split('/').slice(0, 3).join('/')} failed: ${res.status} ${body?.error?.message ?? ''}`,
      );
      throw new BadGatewayException(
        'The payment provider could not be reached. Please try again.',
      );
    }
    return body;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const form = new URLSearchParams({
      mode: 'payment',
      client_reference_id: request.orderId,
      customer_email: request.email,
      origin_context: 'mobile_app',
      success_url: paymentCallbackUrl(this.config, {
        orderId: request.orderId,
      }),
      cancel_url: paymentCallbackUrl(this.config, {
        orderId: request.orderId,
        cancelled: '1',
      }),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': request.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(
        toMinorUnits(request.amount),
      ),
      'line_items[0][price_data][product_data][name]': `PIC Events order ${request.orderId.slice(0, 8).toUpperCase()}`,
      'metadata[orderId]': request.orderId,
      'payment_intent_data[metadata][orderId]': request.orderId,
    });
    const session = await this.call('/checkout/sessions', form);
    if (!session.id || !session.url) {
      throw new BadGatewayException(
        'The payment provider could not start the checkout. Please try again.',
      );
    }
    return {
      reference: session.id,
      status: 'pending',
      checkoutUrl: session.url,
    };
  }

  async verify(reference: string): Promise<PaymentEvent> {
    const session = await this.call(
      `/checkout/sessions/${encodeURIComponent(reference)}`,
    );
    return eventFrom(session, reference);
  }

  webhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'Stripe webhooks are not configured',
      );
    }
    if (!stripeSignatureValid(rawBody, signature, secret)) {
      throw new BadRequestException('Invalid signature');
    }
    let event: { type?: string; data?: { object?: CheckoutSession } };
    try {
      event = JSON.parse(rawBody.toString('utf8')) as typeof event;
    } catch {
      throw new BadRequestException('Invalid payload');
    }
    const session = event.data?.object;
    const confirms =
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded';
    if (!confirms || !session?.id) return null;
    return eventFrom(session, session.id);
  }
}
