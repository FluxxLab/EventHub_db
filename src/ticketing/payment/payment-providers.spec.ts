import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { LogPaymentProvider } from './log-payment.provider';
import { FlutterwaveProvider } from './flutterwave.provider';
import { PaymentRouter } from './payment-router';
import { PaystackProvider } from './paystack.provider';
import { StripeProvider } from './stripe.provider';
import {
  paystackSignatureValid,
  stripeSignatureValid,
} from './webhook-signature';

const ORDER = '11111111-2222-4333-8444-555555555555';

const configWith = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

const jsonResponse = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

const stripeHeader = (body: string, secret: string, t: number) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('webhook signatures', () => {
  const body = Buffer.from('{"event":"charge.success"}');

  it('accepts a Paystack HMAC-SHA512 of the raw body and rejects anything else', () => {
    const good = createHmac('sha512', 'sk_test').update(body).digest('hex');
    expect(paystackSignatureValid(body, good, 'sk_test')).toBe(true);
    expect(paystackSignatureValid(body, good, 'sk_other')).toBe(false);
    expect(
      paystackSignatureValid(Buffer.from('{"event":"x"}'), good, 'sk_test'),
    ).toBe(false);
    expect(paystackSignatureValid(body, undefined, 'sk_test')).toBe(false);
    expect(paystackSignatureValid(body, 'abc', 'sk_test')).toBe(false);
  });

  it('accepts a fresh Stripe signature, rejects a wrong one and a stale one', () => {
    const now = 1_790_000_000;
    const raw = body.toString();
    expect(
      stripeSignatureValid(body, stripeHeader(raw, 'whsec', now), 'whsec', now),
    ).toBe(true);
    // A second v1 (secret rotation) still counts when one matches.
    expect(
      stripeSignatureValid(
        body,
        `${stripeHeader(raw, 'whsec', now)},v1=deadbeef`,
        'whsec',
        now,
      ),
    ).toBe(true);
    expect(
      stripeSignatureValid(body, stripeHeader(raw, 'other', now), 'whsec', now),
    ).toBe(false);
    expect(
      stripeSignatureValid(
        body,
        stripeHeader(raw, 'whsec', now - 301),
        'whsec',
        now,
      ),
    ).toBe(false);
    expect(
      stripeSignatureValid(
        body,
        stripeHeader(raw, 'whsec', now - 299),
        'whsec',
        now,
      ),
    ).toBe(true);
    expect(stripeSignatureValid(body, undefined, 'whsec', now)).toBe(false);
    expect(stripeSignatureValid(body, `t=${now}`, 'whsec', now)).toBe(false);
  });
});

describe('PaymentRouter', () => {
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

  it('sends Nigeria, Ghana, Kenya and South Africa to Paystack, everyone else to Stripe', () => {
    const r = router({
      PAYMENT_GATEWAY: 'paystack-stripe',
      PAYSTACK_SECRET_KEY: 'sk',
      STRIPE_SECRET_KEY: 'sk',
    });
    for (const country of ['NG', 'GH', 'KE', 'ZA']) {
      expect(r.select({ amount: 100, country }).name).toBe('paystack');
    }
    for (const country of ['US', 'GB', 'FR']) {
      expect(r.select({ amount: 100, country }).name).toBe('stripe');
    }
    // No billing country recorded is Nigeria, as everywhere else.
    expect(r.select({ amount: 100, country: null }).name).toBe('paystack');
  });

  it('falls back to the log provider when the key is unset, warning once', () => {
    const r = router({
      PAYMENT_GATEWAY: 'paystack-stripe',
      STRIPE_SECRET_KEY: 'sk',
    });
    const warn = jest
      .spyOn((r as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(r.select({ amount: 100, country: 'NG' }).name).toBe('log');
    expect(r.select({ amount: 100, country: 'GH' }).name).toBe('log');
    expect(r.select({ amount: 100, country: 'US' }).name).toBe('stripe');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never opens a checkout for a free order', () => {
    const r = router({
      PAYMENT_GATEWAY: 'paystack-stripe',
      PAYSTACK_SECRET_KEY: 'sk',
    });
    expect(r.select({ amount: 0, country: 'NG' }).name).toBe('log');
  });

  it('labels the result with the provider that took it', async () => {
    const r = router({});
    jest
      .spyOn((r as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const result = await r.charge({
      orderId: ORDER,
      amount: 100,
      currency: 'NGN',
      method: 'card',
      email: 'ada@example.com',
      country: 'NG',
    });
    expect(result).toMatchObject({ status: 'paid', provider: 'log' });
  });

  it('cannot verify through a provider with no key', async () => {
    await expect(router({}).verify('paystack', 'ref')).resolves.toBeNull();
  });
});

describe('PaystackProvider', () => {
  const config = configWith({
    PAYSTACK_SECRET_KEY: 'sk_test_paystack',
    PAYMENT_CALLBACK_URL: 'picevents://payment/return',
  });
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('initialises a transaction for the total in kobo, in the order currency, limited to the chosen channel', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/abc',
          reference: `${ORDER}-aa`,
        },
      }),
    );
    const result = await new PaystackProvider(config).charge({
      orderId: ORDER,
      amount: 30500,
      currency: 'NGN',
      method: 'transfer',
      email: 'ada@example.com',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test_paystack',
    );
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      amount: 3050000,
      currency: 'NGN',
      email: 'ada@example.com',
      channels: ['bank_transfer'],
      callback_url: `picevents://payment/return?orderId=${ORDER}`,
      metadata: { orderId: ORDER },
    });
    expect(sent.reference).toMatch(new RegExp(`^${ORDER}-[0-9a-f]{8}$`));
    expect(result).toEqual({
      reference: `${ORDER}-aa`,
      status: 'pending',
      checkoutUrl: 'https://checkout.paystack.com/abc',
    });
  });

  it('maps each method to its Paystack channel', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        status: true,
        data: { authorization_url: 'https://x', reference: 'r' },
      }),
    );
    const p = new PaystackProvider(config);
    for (const method of ['card', 'ussd', 'wallet'] as const) {
      await p.charge({
        orderId: ORDER,
        amount: 1,
        currency: 'GHS',
        method,
        email: 'a@b.c',
      });
    }
    const channels = fetchMock.mock.calls.map(
      (c: [string, RequestInit]) =>
        (JSON.parse(c[1].body as string) as { channels: string[] }).channels,
    );
    expect(channels).toEqual([['card'], ['ussd'], ['mobile_money']]);
  });

  it('reads verify results in the smallest unit', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        status: true,
        data: {
          status: 'success',
          reference: 'ref1',
          amount: 3050000,
          currency: 'NGN',
          metadata: { orderId: ORDER },
        },
      }),
    );
    await expect(new PaystackProvider(config).verify('ref1')).resolves.toEqual({
      provider: 'paystack',
      reference: 'ref1',
      orderId: ORDER,
      status: 'paid',
      amount: 3050000,
      currency: 'NGN',
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api.paystack.co/transaction/verify/ref1',
    );
  });

  it('reads charge.success webhooks and ignores other events', () => {
    const p = new PaystackProvider(config);
    const sign = (b: string) =>
      createHmac('sha512', 'sk_test_paystack').update(b).digest('hex');
    const success = JSON.stringify({
      event: 'charge.success',
      data: {
        status: 'success',
        reference: 'ref1',
        amount: 100,
        currency: 'NGN',
        metadata: JSON.stringify({ orderId: ORDER }),
      },
    });
    expect(p.webhook(Buffer.from(success), sign(success))).toMatchObject({
      status: 'paid',
      reference: 'ref1',
      orderId: ORDER,
    });
    const other = JSON.stringify({ event: 'transfer.success', data: {} });
    expect(p.webhook(Buffer.from(other), sign(other))).toBeNull();
    expect(() => p.webhook(Buffer.from(success), 'nope')).toThrow(
      BadRequestException,
    );
  });

  it('refuses webhooks when not configured', () => {
    expect(() =>
      new PaystackProvider(configWith({})).webhook(Buffer.from('{}'), 'x'),
    ).toThrow(ServiceUnavailableException);
  });
});

describe('StripeProvider', () => {
  const config = configWith({
    STRIPE_SECRET_KEY: 'sk_test_stripe',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  });
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('creates a Checkout Session with one line for the total in cents', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/1',
      }),
    );
    const result = await new StripeProvider(config).charge({
      orderId: ORDER,
      amount: 151,
      currency: 'USD',
      method: 'card',
      email: 'ada@example.com',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('client_reference_id')).toBe(ORDER);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('15100');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('success_url')).toBe(
      `picevents://payment/return?orderId=${ORDER}`,
    );
    expect(form.get('cancel_url')).toBe(
      `picevents://payment/return?orderId=${ORDER}&cancelled=1`,
    );
    expect(result).toEqual({
      reference: 'cs_test_1',
      status: 'pending',
      checkoutUrl: 'https://checkout.stripe.com/c/1',
    });
  });

  it('reads a session: paid, expired, still open', async () => {
    const p = new StripeProvider(config);
    fetchMock = jest.spyOn(global, 'fetch');
    const cases: [object, string][] = [
      [{ payment_status: 'paid', status: 'complete' }, 'paid'],
      [{ payment_status: 'unpaid', status: 'expired' }, 'failed'],
      [{ payment_status: 'unpaid', status: 'open' }, 'pending'],
    ];
    for (const [session, status] of cases) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: 'cs_1',
          amount_total: 15100,
          currency: 'usd',
          client_reference_id: ORDER,
          ...session,
        }),
      );
      await expect(p.verify('cs_1')).resolves.toMatchObject({
        status,
        orderId: ORDER,
        amount: 15100,
        currency: 'USD',
      });
    }
  });

  it('reads checkout.session.completed webhooks with a fresh signature', () => {
    const p = new StripeProvider(config);
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          client_reference_id: ORDER,
          amount_total: 100,
          currency: 'usd',
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    expect(
      p.webhook(Buffer.from(body), stripeHeader(body, 'whsec_test', now)),
    ).toMatchObject({ status: 'paid', orderId: ORDER, reference: 'cs_1' });
    expect(() =>
      p.webhook(Buffer.from(body), stripeHeader(body, 'whsec_test', now - 600)),
    ).toThrow(BadRequestException);
    const ignored = JSON.stringify({
      type: 'payment_intent.created',
      data: {},
    });
    expect(
      p.webhook(Buffer.from(ignored), stripeHeader(ignored, 'whsec_test', now)),
    ).toBeNull();
  });
});
