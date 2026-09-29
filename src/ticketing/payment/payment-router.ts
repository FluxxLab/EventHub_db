import { ConfigService } from '@nestjs/config';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LogPaymentProvider } from './log-payment.provider';
import { paymentOptionsFor } from './payment-options';
import type {
  ChargeRequest,
  ChargeResult,
  HostedCheckoutProvider,
  PaymentEvent,
  PaymentProvider,
} from './payment-provider.interface';
import { FlutterwaveProvider } from './flutterwave.provider';
import { PaystackProvider } from './paystack.provider';
import { StripeProvider } from './stripe.provider';

/**
 * What PAYMENT_PROVIDER resolves to. `PAYMENT_GATEWAY` picks the setup:
 * `flutterwave` (the default) takes every billing country's charges;
 * `paystack-stripe` routes by country instead (payment-options.ts: Paystack
 * for NG/GH/KE/ZA, Stripe for dollars). A free order, or one whose provider
 * has no key set, goes to the log provider, which settles at once, so
 * development and staging keep working without keys.
 */
@Injectable()
export class PaymentRouter implements PaymentProvider {
  readonly name = 'router';
  private readonly logger = new Logger('PaymentRouter');
  private readonly warned = new Set<string>();
  private readonly hosted: Map<string, HostedCheckoutProvider>;

  constructor(
    private readonly log: LogPaymentProvider,
    paystack: PaystackProvider,
    stripe: StripeProvider,
    flutterwave: FlutterwaveProvider,
    private readonly config: ConfigService,
  ) {
    this.hosted = new Map<string, HostedCheckoutProvider>([
      [paystack.name, paystack],
      [stripe.name, stripe],
      [flutterwave.name, flutterwave],
    ]);
  }

  /** The provider a country's charges go to under the configured gateway. */
  private providerFor(country: string | null | undefined): string {
    const gateway =
      this.config.get<string>('PAYMENT_GATEWAY')?.trim().toLowerCase() ||
      'flutterwave';
    return gateway === 'paystack-stripe'
      ? paymentOptionsFor(country).provider
      : 'flutterwave';
  }

  /** Whether a provider's webhooks must be confirmed with its API before settling. */
  verifiesWebhooks(provider: string): boolean {
    const hosted = this.hosted.get(provider);
    return hosted?.verifyWebhooks === true;
  }

  /** The provider that takes this charge. */
  select(
    request: Pick<ChargeRequest, 'amount' | 'country'>,
  ): Pick<PaymentProvider, 'name' | 'charge'> {
    if (request.amount <= 0) return this.log;
    const wanted = this.providerFor(request.country);
    const provider = this.hosted.get(wanted);
    if (provider?.configured) return provider;
    if (!this.warned.has(wanted)) {
      this.warned.add(wanted);
      this.logger.warn(
        `${wanted} is not configured; its orders are settled by the log provider without charging anyone`,
      );
    }
    return this.log;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const provider = this.select(request);
    const result = await provider.charge(request);
    return { ...result, provider: provider.name };
  }

  /** Null for a provider that cannot be asked: the log provider, or one no longer configured. */
  async verify(
    provider: string,
    reference: string,
  ): Promise<PaymentEvent | null> {
    const hosted = this.hosted.get(provider);
    if (!hosted?.configured) return null;
    return hosted.verify(reference);
  }

  webhook(
    provider: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): PaymentEvent | null {
    const hosted = this.hosted.get(provider);
    if (!hosted) {
      throw new ServiceUnavailableException(`${provider} is not configured`);
    }
    return hosted.webhook(rawBody, signature);
  }
}
