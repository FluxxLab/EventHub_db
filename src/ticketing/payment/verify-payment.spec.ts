import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { EditionsService } from '../../editions/editions.service';
import type { EmailSender } from '../../notifications/email/email-sender.interface';
import type { AdmissionService } from '../admission.service';
import { Order, OrderStatus } from '../entities/order.entity';
import type { TicketType } from '../entities/ticket-type.entity';
import type { Ticket } from '../entities/ticket.entity';
import type { Voucher } from '../entities/voucher.entity';
import { TicketingService } from '../ticketing.service';
import type {
  PaymentEvent,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * The order lifecycle around a hosted checkout: pay opens it for the order's
 * own total, the app's verify call and the webhooks settle it only when the
 * provider collected exactly that, and only once.
 */
const ORDER = '11111111-2222-4333-8444-555555555555';

function setup(order: Partial<Order> = {}) {
  const theOrder = {
    id: ORDER,
    delegateId: 'buyer',
    editionId: 'e1',
    status: OrderStatus.PENDING,
    lines: [
      { ticketTypeId: 't1', name: 'Standard', quantity: 2, unitPrice: 15000 },
    ],
    attendees: [],
    voucherCode: null,
    discount: 0,
    adminFee: 500,
    total: 30500,
    currency: 'NGN',
    country: 'NG',
    guestName: 'Ada Okafor',
    guestEmail: 'ada@example.com',
    provider: 'paystack',
    providerRef: `${ORDER}-aa`,
    ...order,
  } as Order;
  const orders = {
    findOne: jest.fn(({ where }: { where: Partial<Order> }) =>
      Promise.resolve(
        (where.id && where.id === theOrder.id) ||
          (where.providerRef && where.providerRef === theOrder.providerRef)
          ? theOrder
          : null,
      ),
    ),
    findOneByOrFail: jest.fn(() => Promise.resolve(theOrder)),
    save: jest.fn((o: Order) => Promise.resolve(o)),
  };
  const types = {
    find: jest.fn().mockResolvedValue([
      {
        id: 't1',
        name: 'Standard',
        isActive: true,
        prices: { NGN: 15000 },
        price: 15000,
        capacity: null,
        sold: 0,
      },
    ]),
  };
  const payments: jest.Mocked<Required<PaymentProvider>> = {
    name: 'router',
    charge: jest.fn().mockResolvedValue({
      reference: `${ORDER}-bb`,
      status: 'pending',
      checkoutUrl: 'https://checkout.paystack.com/x',
      provider: 'paystack',
    }),
    verify: jest.fn(),
    webhook: jest.fn(),
    verifiesWebhooks: jest.fn().mockReturnValue(false),
  };
  const service = new TicketingService(
    types as unknown as Repository<TicketType>,
    orders as unknown as Repository<Order>,
    {} as Repository<Ticket>,
    {} as Repository<Voucher>,
    {} as DataSource,
    {
      card: jest.fn().mockResolvedValue({ id: 'e1', name: 'GS-27' }),
    } as unknown as EditionsService,
    { get: () => undefined } as unknown as ConfigService,
    payments,
    {} as AdmissionService,
    {} as EmailSender,
  );
  // settle's own behaviour is covered in settle-holders.spec; here it only has to flip the order.
  const settle = jest
    .spyOn(service, 'settle')
    .mockImplementation((_id: string, ref: string) => {
      theOrder.status = OrderStatus.PAID;
      theOrder.providerRef = ref;
      return Promise.resolve();
    });
  const logger = (service as unknown as { logger: Record<string, unknown> })
    .logger;
  logger.error = jest.fn();
  logger.warn = jest.fn();
  return { service, payments, settle, order: theOrder, orders };
}

const paid = (over: Partial<PaymentEvent> = {}): PaymentEvent => ({
  provider: 'paystack',
  reference: `${ORDER}-aa`,
  orderId: ORDER,
  status: 'paid',
  amount: 3050000,
  currency: 'NGN',
  ...over,
});

describe('TicketingService.pay with a hosted checkout', () => {
  it("charges the order's own total and currency, records the provider, and leaves it pending", async () => {
    const { service, payments, settle, order } = setup({
      provider: null,
      providerRef: null,
    });
    const result = await service.pay(ORDER, 'buyer', 'card');
    expect(payments.charge).toHaveBeenCalledWith({
      orderId: ORDER,
      amount: 30500,
      currency: 'NGN',
      method: 'card',
      email: 'ada@example.com',
      country: 'NG',
    });
    expect(result).toEqual({
      reference: `${ORDER}-bb`,
      status: OrderStatus.PENDING,
      checkoutUrl: 'https://checkout.paystack.com/x',
    });
    expect(order.provider).toBe('paystack');
    expect(order.providerRef).toBe(`${ORDER}-bb`);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('TicketingService.verifyPayment', () => {
  it('asks the provider the order was charged through and settles once', async () => {
    const { service, payments, settle } = setup();
    payments.verify.mockResolvedValue(paid());
    const first = await service.verifyPayment(ORDER, 'buyer');
    const second = await service.verifyPayment(ORDER, 'buyer');
    expect(payments.verify).toHaveBeenCalledTimes(1);
    expect(payments.verify).toHaveBeenCalledWith('paystack', `${ORDER}-aa`);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(OrderStatus.PAID);
    expect(second.status).toBe(OrderStatus.PAID);
  });

  it('leaves the order pending while the provider has not been paid', async () => {
    const { service, payments, settle } = setup();
    payments.verify.mockResolvedValue(paid({ status: 'pending' }));
    const view = await service.verifyPayment(ORDER, 'buyer');
    expect(view.status).toBe(OrderStatus.PENDING);
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not settle when the provider collected a different amount or currency', async () => {
    for (const wrong of [{ amount: 100 }, { currency: 'USD' }]) {
      const { service, payments, settle } = setup();
      payments.verify.mockResolvedValue(paid(wrong));
      const view = await service.verifyPayment(ORDER, 'buyer');
      expect(view.status).toBe(OrderStatus.PENDING);
      expect(settle).not.toHaveBeenCalled();
    }
  });

  it("refuses someone else's order", async () => {
    const { service } = setup();
    await expect(service.verifyPayment(ORDER, 'stranger')).rejects.toThrow();
  });
});

describe('TicketingService.paymentWebhook', () => {
  it('settles the order whose provider reference matches', async () => {
    const { service, payments, settle } = setup();
    payments.webhook.mockReturnValue(paid({ orderId: null }));
    await expect(
      service.paymentWebhook('paystack', Buffer.from('{}'), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(payments.webhook).toHaveBeenCalledWith(
      'paystack',
      Buffer.from('{}'),
      'sig',
    );
    expect(settle).toHaveBeenCalledWith(ORDER, `${ORDER}-aa`);
  });

  it('finds a Stripe order by client_reference_id when the session is not the stored one', async () => {
    const { service, payments, settle } = setup({
      provider: 'stripe',
      providerRef: 'cs_new',
      currency: 'USD',
      total: 151,
    });
    payments.webhook.mockReturnValue(
      paid({
        provider: 'stripe',
        reference: 'cs_old',
        amount: 15100,
        currency: 'USD',
      }),
    );
    await service.paymentWebhook('stripe', Buffer.from('{}'), 'sig');
    expect(settle).toHaveBeenCalledWith(ORDER, 'cs_old');
  });

  it('is idempotent: a repeated event does not settle twice', async () => {
    const { service, payments, settle } = setup();
    payments.webhook.mockReturnValue(paid());
    await service.paymentWebhook('paystack', Buffer.from('{}'), 'sig');
    await service.paymentWebhook('paystack', Buffer.from('{}'), 'sig');
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('acknowledges ignored events and unknown orders without settling', async () => {
    const { service, payments, settle } = setup();
    payments.webhook.mockReturnValueOnce(null);
    payments.webhook.mockReturnValueOnce(
      paid({ reference: 'unknown', orderId: 'not-a-uuid' }),
    );
    await expect(
      service.paymentWebhook('paystack', Buffer.from('{}'), 'sig'),
    ).resolves.toEqual({ received: true });
    await expect(
      service.paymentWebhook('paystack', Buffer.from('{}'), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(settle).not.toHaveBeenCalled();
  });

  it('passes a bad signature through as 400', async () => {
    const { service, payments } = setup();
    payments.webhook.mockImplementation(() => {
      throw new BadRequestException('Invalid signature');
    });
    await expect(
      service.paymentWebhook('stripe', Buffer.from('{}'), 'bad'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('acknowledges a paid order that sold out meanwhile, and logs it for a refund', async () => {
    const { service, payments, settle } = setup();
    payments.webhook.mockReturnValue(paid());
    settle.mockRejectedValueOnce(
      new BadRequestException('Standard sold out before payment completed'),
    );
    await expect(
      service.paymentWebhook('paystack', Buffer.from('{}'), 'sig'),
    ).resolves.toEqual({ received: true });
  });
});

describe('TicketingService.paymentWebhook for Flutterwave', () => {
  it('re-verifies with Flutterwave and settles on what the API says, not the webhook body', async () => {
    const { service, payments, settle } = setup({ provider: 'flutterwave' });
    payments.webhook.mockReturnValue(paid({ provider: 'flutterwave' }));
    payments.verifiesWebhooks.mockReturnValue(true);
    payments.verify.mockResolvedValue(paid({ provider: 'flutterwave' }));
    await service.paymentWebhook('flutterwave', Buffer.from('{}'), 'hash');
    expect(payments.verify).toHaveBeenCalledWith('flutterwave', `${ORDER}-aa`);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('does not settle when the webhook claims paid but the API does not', async () => {
    const { service, payments, settle } = setup({ provider: 'flutterwave' });
    payments.webhook.mockReturnValue(paid({ provider: 'flutterwave' }));
    payments.verifiesWebhooks.mockReturnValue(true);
    payments.verify.mockResolvedValue(
      paid({ provider: 'flutterwave', status: 'pending' }),
    );
    await expect(
      service.paymentWebhook('flutterwave', Buffer.from('{}'), 'hash'),
    ).resolves.toEqual({ received: true });
    expect(settle).not.toHaveBeenCalled();
  });
});
