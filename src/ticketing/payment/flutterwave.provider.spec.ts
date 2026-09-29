import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LogPaymentProvider } from './log-payment.provider';
import {
  FlutterwaveProvider,
  flutterwaveOptions,
  orderIdFromTxRef,
} from './flutterwave.provider';
import { PaymentRouter } from './payment-router';
import { PaystackProvider } from './paystack.provider';
import { StripeProvider } from './stripe.provider';

/**
 * Flutterwave takes every country's charges by default. What matters: the
 * checkout is for the order's own amount in major units, the tx_ref leads
 * back to the order, verification converts to the smallest unit the settle
 * check compares in, and a webhook without the right secret hash is refused.
 */
const ORDER = '11111111-1111-4111-8111-111111111111';
const configWith = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;
const response = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

describe('FlutterwaveProvider', () => {
  const provider = new FlutterwaveProvider(
    configWith({
      FLUTTERWAVE_SECRET_KEY: 'FLWSECK-test',
      FLUTTERWAVE_WEBHOOK_HASH: 'my-hash',
    }),
  );
  afterEach(() => jest.restoreAllMocks());

  it('opens a hosted checkout for the order total in major units, limited to the chosen method', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' },
      }),
    );
    const result = await provider.charge({
      orderId: ORDER,
      amount: 250,
      currency: 'GHS',
      method: 'wallet',
      email: 'ada@example.com',
      country: 'GH',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(url).toBe('https://api.flutterwave.com/v3/payments');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer FLWSECK-test',
    );
    expect(body).toMatchObject({
      amount: 250,
      currency: 'GHS',
      payment_options: 'mobilemoneyghana',
      customer: { email: 'ada@example.com' },
      meta: { orderId: ORDER },
    });
    expect(body.redirect_url).toBe(
      `picevents://payment/return?orderId=${ORDER}`,
    );
    expect(String(body.tx_ref)).toMatch(new RegExp(`^${ORDER}-[0-9a-f]{8}$`));
    expect(result).toEqual({
      reference: body.tx_ref,
      status: 'pending',
      checkoutUrl: 'https://checkout.flutterwave.com/v3/hosted/pay/abc',
    });
  });

  it('verifies by tx_ref and reports the amount in the smallest unit', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        data: {
          status: 'successful',
          tx_ref: `${ORDER}-aa`,
          amount: 30500,
          currency: 'ngn',
        },
      }),
    );
    await expect(provider.verify(`${ORDER}-aa`)).resolves.toEqual({
      provider: 'flutterwave',
      reference: `${ORDER}-aa`,
      orderId: ORDER,
      status: 'paid',
      amount: 3050000,
      currency: 'NGN',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${ORDER}-aa`,
    );
  });

  it('treats "no transaction yet" as not paid rather than an outage', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        response(
          { status: 'error', message: 'No transaction was found for this id' },
          false,
        ),
      );
    await expect(provider.verify(`${ORDER}-aa`)).resolves.toMatchObject({
      status: 'pending',
      orderId: ORDER,
    });
  });

  it('accepts a webhook only with the dashboard secret hash', () => {
    const body = Buffer.from(
      JSON.stringify({
        event: 'charge.completed',
        data: {
          status: 'successful',
          tx_ref: `${ORDER}-aa`,
          amount: 100,
          currency: 'NGN',
        },
      }),
    );
    expect(provider.webhook(body, 'my-hash')).toMatchObject({
      status: 'paid',
      orderId: ORDER,
      amount: 10000,
    });
    expect(() => provider.webhook(body, 'wrong')).toThrow(BadRequestException);
    expect(() => provider.webhook(body, undefined)).toThrow(
      BadRequestException,
    );
    const other = Buffer.from(
      JSON.stringify({ event: 'transfer.completed', data: { tx_ref: 'x' } }),
    );
    expect(provider.webhook(other, 'my-hash')).toBeNull();
  });

  it('refuses webhooks when the hash is not configured', () => {
    const bare = new FlutterwaveProvider(
      configWith({ FLUTTERWAVE_SECRET_KEY: 'k' }),
    );
    expect(() => bare.webhook(Buffer.from('{}'), 'x')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('maps each payment method to a Flutterwave option', () => {
    expect(flutterwaveOptions('card', 'NGN')).toBe('card');
    expect(flutterwaveOptions('transfer', 'NGN')).toBe('banktransfer');
    expect(flutterwaveOptions('ussd', 'NGN')).toBe('ussd');
    expect(flutterwaveOptions('wallet', 'KES')).toBe('mpesa');
    expect(orderIdFromTxRef('nonsense')).toBeNull();
  });
});

describe('PaymentRouter with Flutterwave', () => {
  const router = (env: Record<string, string>) => {
    const config = configWith(env);
    return new PaymentRouter(
      new LogPaymentProvider(),
      new PaystackProvider(config),
      new StripeProvider(config),
      new FlutterwaveProvider(config),
      config,
    );
  };

  it('sends every country to Flutterwave by default', () => {
    const r = router({
      FLUTTERWAVE_SECRET_KEY: 'k',
      PAYSTACK_SECRET_KEY: 'k',
      STRIPE_SECRET_KEY: 'k',
    });
    for (const country of ['NG', 'GH', 'KE', 'ZA', 'US', 'GB', null]) {
      expect(r.select({ amount: 100, country }).name).toBe('flutterwave');
    }
    expect(r.verifiesWebhooks('flutterwave')).toBe(true);
    expect(r.verifiesWebhooks('paystack')).toBe(false);
  });

  it('falls back to the log provider without a Flutterwave key', () => {
    const r = router({});
    jest
      .spyOn((r as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(r.select({ amount: 100, country: 'NG' }).name).toBe('log');
  });
});
