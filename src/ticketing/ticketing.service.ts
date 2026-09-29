import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Delegate } from '../delegate/entities/delegate.entity';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import {
  checkAttendees,
  holderNoticeText,
  resolveHolder,
  type HolderNotice,
} from './ticket-holders';
import { AdmissionService } from './admission.service';
import { uniqueTicketCode } from './ticket-code';
import { DataSource, In, Repository } from 'typeorm';
import { EditionCardView, EditionsService } from '../editions/editions.service';
import {
  ApplyVoucherDto,
  CreateOrderDto,
  CreateTicketTypeDto,
  QuoteOrderDto,
  UpdateTicketTypeDto,
} from './dto/ticketing.dto';
import { Order, OrderLineSnapshot, OrderStatus } from './entities/order.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { Voucher } from './entities/voucher.entity';
import {
  ADMIN_FEE,
  CURRENCIES,
  normaliseCountry,
  paymentOptionsFor,
  type Currency,
  type PaymentOptions,
} from './payment/payment-options';
import {
  PAYMENT_PROVIDER,
  toMinorUnits,
} from './payment/payment-provider.interface';
import type {
  PaymentEvent,
  PaymentMethod,
  PaymentProvider,
} from './payment/payment-provider.interface';

/** Priced lines and totals, the only place money is added up (TR-02). */
export interface OrderQuote {
  lines: (OrderLineSnapshot & { amount: number })[];
  adminFee: number;
  discount: { code: string; amount: number } | null;
  subtotal: number;
  /** The currency every figure above is in. */
  currency: Currency;
  country: string;
}

export interface OrderView extends OrderQuote {
  id: string;
  editionId: string;
  edition: EditionCardView;
  status: OrderStatus;
  guest: { name: string; email: string; phone: string | null };
  voucherCode: string | null;
  /** Methods the delegate's billing country allows, for the payment screen. */
  paymentMethods: PaymentOptions['methods'];
  paymentMethod: string | null;
  provider: string | null;
  providerRef: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface TicketView {
  id: string;
  orderId: string;
  editionId: string;
  edition: EditionCardView;
  ticketTypeId: string;
  tierName: string;
  quantity: number;
  code: string;
  /** What the ticket's QR encodes; signed, scanned at the entrance gate. Null for a ticket you bought for someone else. */
  qr: string | null;
  /** True when the caller holds it; false when they bought it for someone else. */
  mine: boolean;
  /** Who it is for, as named at checkout (or when last passed on). */
  holder: { name: string; email: string };
  /** People through the entrance gate on this ticket so far (a ticket for N admits N). */
  admitted: number;
  lastAdmittedAt: Date | null;
  /** Whether the caller may change who it is for now: they bought it, nobody is in on it yet, and the event has not ended. */
  transferable: boolean;
  guest: { name: string; email: string };
  section: string;
  row: string;
  createdAt: Date;
}

const DEFAULT_ADMIN_FEE = 500;

/** The event has finished: past its end, or a day after its start without one. */
export function isOver(
  edition: Pick<EditionCardView, 'startsAt' | 'endsAt'> | undefined,
  now = Date.now(),
): boolean {
  if (!edition) return false;
  const end = edition.endsAt
    ? new Date(edition.endsAt).getTime()
    : new Date(edition.startsAt).getTime() + 24 * 60 * 60 * 1000;
  return end < now;
}

@Injectable()
export class TicketingService {
  private readonly logger = new Logger('TicketingService');

  constructor(
    @InjectRepository(TicketType)
    private readonly types: Repository<TicketType>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(Voucher)
    private readonly vouchers: Repository<Voucher>,
    private readonly dataSource: DataSource,
    private readonly editions: EditionsService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER)
    private readonly payments: PaymentProvider,
    private readonly admission: AdmissionService,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
  ) {}

  /* ------------------------------------------------------------ ticket types */

  /** The pricing tab: active tiers in display order. Drafts are hidden with their edition. */
  async ticketTypes(editionId: string): Promise<TicketType[]> {
    await this.editions.card(editionId);
    return this.types.find({
      where: { editionId, isActive: true },
      order: { sortOrder: 'ASC', price: 'ASC' },
    });
  }

  /**
   * Every tier of an edition, on sale or not, for the organiser console. Unlike
   * the pricing tab, drafts are included (findById, not card) and inactive
   * tiers are not filtered out, so a tier taken off sale can be found again.
   */
  async allTicketTypes(editionId: string): Promise<TicketType[]> {
    await this.editions.findById(editionId);
    return this.types.find({
      where: { editionId },
      order: { sortOrder: 'ASC', price: 'ASC' },
    });
  }

  async createTicketType(
    editionId: string,
    dto: CreateTicketTypeDto,
  ): Promise<TicketType> {
    await this.editions.findById(editionId);
    return this.types.save(
      this.types.create({
        editionId,
        name: dto.name.trim(),
        ...this.priceFields(dto.price, dto.prices),
        perks: dto.perks ?? [],
        section: dto.section?.trim() || 'General',
        capacity: dto.capacity ?? null,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
  }

  async updateTicketType(
    id: string,
    dto: UpdateTicketTypeDto,
  ): Promise<TicketType> {
    const type = await this.types.findOne({ where: { id } });
    if (!type) throw new NotFoundException('Ticket type not found');
    Object.assign(type, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...((dto.price !== undefined || dto.prices !== undefined) &&
        this.priceFields(dto.price ?? type.price ?? undefined, {
          ...type.prices,
          ...dto.prices,
        })),
      ...(dto.perks !== undefined && { perks: dto.perks }),
      ...(dto.section !== undefined && {
        section: dto.section.trim() || 'General',
      }),
      ...(dto.capacity !== undefined && { capacity: dto.capacity }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
    });
    return this.types.save(type);
  }

  /**
   * `price` and `prices.NGN` are one fact stored twice for old clients; keep
   * them equal. Unknown currencies are dropped rather than stored.
   */
  private priceFields(
    price: number | undefined,
    prices: Record<string, number> | undefined,
  ): { price: number | null; prices: Record<string, number> } {
    const clean: Record<string, number> = {};
    for (const [code, amount] of Object.entries(prices ?? {})) {
      const currency = code.toUpperCase();
      if (
        (CURRENCIES as readonly string[]).includes(currency) &&
        Number.isInteger(amount) &&
        amount >= 0
      ) {
        clean[currency] = amount;
      }
    }
    const ngn = price ?? clean.NGN;
    if (ngn !== undefined) clean.NGN = ngn;
    return { price: ngn ?? null, prices: clean };
  }

  /* ------------------------------------------------------------------ quoting */

  private adminFee(currency: Currency): number {
    if (currency === 'NGN') {
      return this.config.get<number>('TICKET_ADMIN_FEE') ?? DEFAULT_ADMIN_FEE;
    }
    return ADMIN_FEE[currency];
  }

  /**
   * The currency a basket is priced in: the billing country's, when every
   * tier carries it; otherwise dollars, when every tier carries that; and
   * naira as the floor, since a buyable tier always has one.
   */
  private resolveCurrency(types: TicketType[], wanted: Currency): Currency {
    const all = (c: Currency) => types.every((t) => t.prices[c] !== undefined);
    if (all(wanted)) return wanted;
    if (all('USD')) return 'USD';
    return 'NGN';
  }

  /**
   * Price a set of lines against the live tiers. Rejects invitation-only
   * and inactive tiers, tiers from another edition, and quantities the
   * remaining capacity cannot cover.
   */
  private async price(
    editionId: string,
    lines: { ticketTypeId: string; quantity: number }[],
    voucherCode?: string | null,
    country?: string | null,
  ): Promise<OrderQuote & { voucher: Voucher | null }> {
    const types = await this.types.find({
      where: { id: In(lines.map((l) => l.ticketTypeId)), editionId },
    });
    const byId = new Map(types.map((t) => [t.id, t]));
    const options = paymentOptionsFor(country);
    const currency = this.resolveCurrency(
      lines
        .map((l) => byId.get(l.ticketTypeId))
        .filter((t): t is TicketType => !!t),
      options.currency,
    );
    const priced: OrderQuote['lines'] = [];
    for (const line of lines) {
      const type = byId.get(line.ticketTypeId);
      if (!type || !type.isActive) {
        throw new BadRequestException(
          'One of the tickets is no longer on sale',
        );
      }
      const unit =
        type.prices[currency] ?? (currency === 'NGN' ? type.price : undefined);
      if (unit === undefined || unit === null) {
        throw new BadRequestException(`${type.name} is by invitation only`);
      }
      if (type.capacity !== null && type.sold + line.quantity > type.capacity) {
        throw new BadRequestException(
          `Only ${Math.max(0, type.capacity - type.sold)} ${type.name} tickets left`,
        );
      }
      priced.push({
        ticketTypeId: type.id,
        name: type.name,
        quantity: line.quantity,
        unitPrice: unit,
        amount: unit * line.quantity,
      });
    }
    const ticketsTotal = priced.reduce((sum, l) => sum + l.amount, 0);
    const adminFee = ticketsTotal > 0 ? this.adminFee(currency) : 0;

    let voucher: Voucher | null = null;
    let discount: OrderQuote['discount'] = null;
    const code = voucherCode?.trim().toUpperCase();
    if (code) {
      voucher = await this.vouchers.findOne({ where: { code } });
      const usable =
        voucher &&
        voucher.active &&
        (voucher.editionId === null || voucher.editionId === editionId) &&
        (voucher.maxUses === null || voucher.uses < voucher.maxUses);
      if (!usable)
        throw new BadRequestException('That voucher code is not valid');
      discount = {
        code,
        amount: Math.round((ticketsTotal * voucher!.percentOff) / 100),
      };
    }
    const subtotal = Math.max(
      0,
      ticketsTotal + adminFee - (discount?.amount ?? 0),
    );
    return {
      lines: priced,
      adminFee,
      discount,
      subtotal,
      voucher,
      currency,
      country: options.country,
    };
  }

  async quote(dto: QuoteOrderDto): Promise<OrderQuote> {
    await this.editions.card(dto.editionId);
    const priced = await this.price(
      dto.editionId,
      dto.lines,
      dto.voucherCode,
      dto.country,
    );
    return {
      lines: priced.lines,
      adminFee: priced.adminFee,
      discount: priced.discount,
      subtotal: priced.subtotal,
      currency: priced.currency,
      country: priced.country,
    };
  }

  /* ------------------------------------------------------------------- orders */

  async createOrder(
    delegateId: string,
    dto: CreateOrderDto,
  ): Promise<OrderView> {
    await this.editions.card(dto.editionId);
    const quote = await this.price(
      dto.editionId,
      dto.lines,
      dto.voucherCode,
      dto.country,
    );
    const attendees = dto.attendees?.length
      ? checkAttendees(quote.lines, dto.attendees)
      : [];
    const order = await this.orders.save(
      this.orders.create({
        delegateId,
        editionId: dto.editionId,
        status: OrderStatus.PENDING,
        currency: quote.currency,
        country: quote.country,
        lines: quote.lines.map((l) => ({
          ticketTypeId: l.ticketTypeId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        adminFee: quote.adminFee,
        voucherCode: quote.discount?.code ?? null,
        discount: quote.discount?.amount ?? 0,
        total: quote.subtotal,
        guestName: dto.guest.name.trim(),
        guestEmail: dto.guest.email.trim().toLowerCase(),
        guestPhone: dto.guest.phone?.trim() || null,
        attendees,
      }),
    );
    return this.view(order);
  }

  private async owned(orderId: string, delegateId: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.delegateId !== delegateId) throw new ForbiddenException();
    return order;
  }

  async getOrder(orderId: string, delegateId: string): Promise<OrderView> {
    return this.view(await this.owned(orderId, delegateId));
  }

  /** Re-prices a pending order with (or without) a voucher; a paid order is a receipt and stays put. */
  async applyVoucher(
    orderId: string,
    delegateId: string,
    dto: ApplyVoucherDto,
  ): Promise<OrderView> {
    const order = await this.owned(orderId, delegateId);
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('This order has already been paid');
    }
    const quote = await this.price(
      order.editionId,
      order.lines,
      dto.code,
      order.country,
    );
    order.voucherCode = quote.discount?.code ?? null;
    order.discount = quote.discount?.amount ?? 0;
    order.adminFee = quote.adminFee;
    order.total = quote.subtotal;
    return this.view(await this.orders.save(order));
  }

  /**
   * Charge and, on settlement, issue the tickets. Capacity is taken in the
   * same transaction as the tickets so two delegates cannot both buy the
   * last seat. A provider that settles later leaves the order pending; its
   * webhook calls `settle`.
   */
  async pay(
    orderId: string,
    delegateId: string,
    method: PaymentMethod,
  ): Promise<{ reference: string; status: OrderStatus; checkoutUrl?: string }> {
    const order = await this.owned(orderId, delegateId);
    if (order.status === OrderStatus.PAID) {
      return { reference: order.providerRef ?? '', status: order.status };
    }
    if (order.status === OrderStatus.CANCELLED) {
      throw new BadRequestException('This order was cancelled');
    }
    // The method must be one the billing country offers; the app only shows those, but the API is the rule.
    const options = paymentOptionsFor(order.country);
    if (!options.methods.some((m) => m.id === method)) {
      throw new BadRequestException(
        `${method} is not available when paying from ${options.countryName}`,
      );
    }
    // Re-check stock right before charging; the quote may be minutes old.
    await this.price(
      order.editionId,
      order.lines,
      order.voucherCode,
      order.country,
    );

    const result = await this.payments.charge({
      orderId: order.id,
      amount: order.total,
      currency: order.currency,
      method,
      email: order.guestEmail,
      country: order.country,
    });
    order.paymentMethod = method;
    order.provider = result.provider ?? this.payments.name;
    order.providerRef = result.reference;
    await this.orders.save(order);

    if (result.status === 'paid') {
      await this.settle(order.id, result.reference);
    }
    const fresh = await this.orders.findOneByOrFail({ id: order.id });
    return {
      reference: result.reference,
      status: fresh.status,
      checkoutUrl: result.checkoutUrl,
    };
  }

  /**
   * The app calls this when the delegate comes back from a hosted checkout:
   * asks the provider how the charge stands and settles on success. The
   * webhook may well have settled it already; either way the order comes
   * back as it now is.
   */
  async verifyPayment(orderId: string, delegateId: string): Promise<OrderView> {
    const order = await this.owned(orderId, delegateId);
    if (
      order.status === OrderStatus.PENDING &&
      order.provider &&
      order.providerRef &&
      this.payments.verify
    ) {
      const event = await this.payments.verify(
        order.provider,
        order.providerRef,
      );
      if (event?.status === 'paid') await this.settleConfirmed(order, event);
    }
    return this.view(await this.orders.findOneByOrFail({ id: order.id }));
  }

  /**
   * A provider's webhook. The signature is checked by the provider (400 when
   * it is wrong); events that do not confirm a payment, or name no order of
   * ours, are acknowledged and ignored so the provider stops retrying.
   */
  async paymentWebhook(
    provider: 'paystack' | 'stripe' | 'flutterwave',
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!this.payments.webhook) {
      throw new ServiceUnavailableException('Payments are not configured');
    }
    const claimed = this.payments.webhook(
      provider,
      rawBody ?? Buffer.alloc(0),
      signature,
    );
    if (!claimed || claimed.status !== 'paid') return { received: true };
    // Flutterwave's webhook carries a shared secret, not a signature over the
    // body: what it says is confirmed with Flutterwave's API before it counts.
    const event =
      this.payments.verifiesWebhooks?.(provider) && this.payments.verify
        ? await this.payments.verify(provider, claimed.reference)
        : claimed;
    if (!event || event.status !== 'paid') return { received: true };

    const order =
      (await this.orders.findOne({
        where: { providerRef: event.reference },
      })) ??
      (event.orderId && isUUID(event.orderId)
        ? await this.orders.findOne({ where: { id: event.orderId } })
        : null);
    if (!order) {
      this.logger.warn(
        `${provider} confirmed ${event.reference}, which matches no order`,
      );
      return { received: true };
    }
    try {
      await this.settleConfirmed(order, event);
    } catch (error) {
      // Sold out between checkout and settlement: the money is in but no
      // ticket can be issued. Retrying will not help; someone must refund.
      if (!(error instanceof BadRequestException)) throw error;
      this.logger.error(
        `Order ${order.id} was paid (${provider} ${event.reference}) but could not be settled: ${error.message}. Refund needed.`,
      );
    }
    return { received: true };
  }

  /**
   * Settles only when the provider collected exactly the order's total in
   * the order's currency; anything else is logged and left pending.
   */
  private async settleConfirmed(
    order: Order,
    event: PaymentEvent,
  ): Promise<boolean> {
    if (order.status === OrderStatus.PAID) return true;
    const expected = toMinorUnits(order.total);
    if (
      event.amount !== expected ||
      event.currency !== order.currency.toUpperCase()
    ) {
      this.logger.error(
        `Order ${order.id}: ${event.provider} ${event.reference} reports ${event.currency} ${event.amount}, expected ${order.currency} ${expected}; not settled`,
      );
      return false;
    }
    await this.settle(order.id, event.reference);
    return true;
  }

  /**
   * Marks paid and issues tickets, once. Safe to call again for the same
   * reference. With named attendees, every place becomes its own ticket in
   * the holder's account: matched by email, or created unclaimed (random
   * password, no consent, tagged) for someone with no account yet. The
   * holders are told by email once the money is in.
   */
  async settle(orderId: string, providerRef: string): Promise<void> {
    // Hashes for accounts that may need creating, done before the locks are
    // taken: bcrypt is deliberately slow and must not hold the ticket rows.
    const pending = await this.orders.findOne({ where: { id: orderId } });
    const placeholderHashes = new Map<string, string>();
    if (pending && pending.status !== OrderStatus.PAID) {
      const emails = [
        ...new Set((pending.attendees ?? []).map((a) => a.email)),
      ];
      const known = emails.length
        ? await this.dataSource
            .getRepository(Delegate)
            .find({ where: { email: In(emails) }, select: { email: true } })
        : [];
      const knownSet = new Set(known.map((d) => d.email));
      for (const email of emails.filter((e) => !knownSet.has(e))) {
        placeholderHashes.set(
          email,
          await bcrypt.hash(randomBytes(32).toString('hex'), 10),
        );
      }
    }

    const notices: HolderNotice[] = [];
    await this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(Order);
      const order = await orders.findOne({
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order || order.status === OrderStatus.PAID) return;

      const types = manager.getRepository(TicketType);
      const tickets = manager.getRepository(Ticket);
      const delegates = manager.getRepository(Delegate);
      const attendees = order.attendees ?? [];
      const buyer = await delegates.findOne({
        where: { id: order.delegateId },
      });

      for (const line of order.lines) {
        const type = await types.findOne({
          where: { id: line.ticketTypeId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!type)
          throw new BadRequestException(
            'One of the tickets is no longer on sale',
          );
        if (
          type.capacity !== null &&
          type.sold + line.quantity > type.capacity
        ) {
          throw new BadRequestException(
            `${type.name} sold out before payment completed`,
          );
        }
        type.sold += line.quantity;
        await types.save(type);

        const named = attendees.filter((a) => a.ticketTypeId === type.id);
        if (named.length === 0) {
          // An order from an older build: one ticket for the whole line, to the buyer.
          await tickets.save(
            tickets.create({
              orderId: order.id,
              delegateId: order.delegateId,
              purchasedBy: null,
              editionId: order.editionId,
              ticketTypeId: type.id,
              tierName: type.name,
              quantity: line.quantity,
              code: await this.uniqueCode(tickets, type),
              guestName: order.guestName,
              guestEmail: order.guestEmail,
              section: type.section,
              row: 'Open',
            }),
          );
          continue;
        }
        for (const attendee of named) {
          const holder = await resolveHolder(
            delegates,
            attendee,
            placeholderHashes.get(attendee.email),
          );
          const forSomeoneElse = holder.delegate.id !== order.delegateId;
          await tickets.save(
            tickets.create({
              orderId: order.id,
              delegateId: holder.delegate.id,
              purchasedBy: forSomeoneElse ? order.delegateId : null,
              editionId: order.editionId,
              ticketTypeId: type.id,
              tierName: type.name,
              quantity: 1,
              code: await this.uniqueCode(tickets, type),
              guestName: attendee.name,
              guestEmail: attendee.email,
              section: type.section,
              row: 'Open',
            }),
          );
          if (forSomeoneElse) {
            notices.push({
              email: attendee.email,
              name: attendee.name,
              created: holder.created,
              buyerName: buyer?.name ?? order.guestName,
              tierName: type.name,
            });
          }
        }
      }
      if (order.voucherCode) {
        await manager
          .getRepository(Voucher)
          .increment({ code: order.voucherCode }, 'uses', 1);
      }
      order.status = OrderStatus.PAID;
      order.providerRef = providerRef;
      order.paidAt = new Date();
      await orders.save(order);
    });

    if (notices.length && pending)
      void this.tellHolders(pending.editionId, notices);
  }

  /** "Someone got you a ticket." Best effort, after the money is in: a failed email never unpays an order. */
  private async tellHolders(
    editionId: string,
    notices: HolderNotice[],
  ): Promise<void> {
    const edition = await this.editions.card(editionId).catch(() => null);
    const eventName = edition?.name ?? 'a PIC event';
    for (const n of notices) {
      const { subject, text } = holderNoticeText(n, eventName);
      await this.email.send(n.email, subject, text).catch(() => undefined);
    }
  }

  private uniqueCode(
    tickets: Repository<Ticket>,
    type: TicketType,
  ): Promise<string> {
    return uniqueTicketCode(tickets, type.section);
  }

  /* ------------------------------------------------------------------ tickets */

  /** Tickets the caller holds, and the ones they bought for other people (without those QRs). */
  async myTickets(delegateId: string): Promise<TicketView[]> {
    const rows = await this.tickets.find({
      where: [{ delegateId }, { purchasedBy: delegateId }],
      order: { createdAt: 'DESC' },
    });
    return this.ticketViews(rows, delegateId);
  }

  async ticket(id: string, delegateId: string): Promise<TicketView> {
    const row = await this.tickets.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Ticket not found');
    if (row.delegateId !== delegateId && row.purchasedBy !== delegateId) {
      throw new ForbiddenException();
    }
    const [view] = await this.ticketViews([row], delegateId);
    return view;
  }

  /** Whether the delegate holds any ticket for the edition; what unlocks the in-event features. */
  async holdsTicket(delegateId: string, editionId: string): Promise<boolean> {
    return this.tickets.existsBy({ delegateId, editionId });
  }

  /* -------------------------------------------------------------------- views */

  private async ticketViews(
    rows: Ticket[],
    callerId: string,
  ): Promise<TicketView[]> {
    // one batch for every edition on the list, not a card() round trip each
    const cards: Map<string, EditionCardView> = await this.editions.cardsByIds(
      rows.map((r) => r.editionId),
    );
    const usage = await this.admission.usage(rows.map((r) => r.id));
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      editionId: r.editionId,
      edition: cards.get(r.editionId)!,
      ticketTypeId: r.ticketTypeId,
      tierName: r.tierName,
      quantity: r.quantity,
      code: r.code,
      // Only the holder gets the entry QR; the buyer of a gift ticket sees who it is for.
      qr:
        r.delegateId === callerId
          ? this.admission.qrFor(r.id, r.qrVersion ?? 0)
          : null,
      mine: r.delegateId === callerId,
      holder: { name: r.guestName, email: r.guestEmail },
      admitted: usage.get(r.id)?.admitted ?? 0,
      lastAdmittedAt: usage.get(r.id)?.lastAdmittedAt ?? null,
      transferable:
        !!r.purchasedBy &&
        r.purchasedBy === callerId &&
        !usage.get(r.id)?.admitted &&
        !isOver(cards.get(r.editionId), now),
      guest: { name: r.guestName, email: r.guestEmail },
      section: r.section,
      row: r.row,
      createdAt: r.createdAt,
    }));
  }

  private async view(order: Order): Promise<OrderView> {
    return {
      id: order.id,
      editionId: order.editionId,
      edition: await this.editions.card(order.editionId),
      status: order.status,
      lines: order.lines.map((l) => ({
        ...l,
        amount: l.unitPrice * l.quantity,
      })),
      adminFee: order.adminFee,
      discount: order.voucherCode
        ? { code: order.voucherCode, amount: order.discount }
        : null,
      subtotal: order.total,
      currency: order.currency as Currency,
      country: normaliseCountry(order.country),
      guest: {
        name: order.guestName,
        email: order.guestEmail,
        phone: order.guestPhone,
      },
      voucherCode: order.voucherCode,
      paymentMethods: paymentOptionsFor(order.country).methods,
      paymentMethod: order.paymentMethod,
      provider: order.provider,
      providerRef: order.providerRef,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    };
  }
}
