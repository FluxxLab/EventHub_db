import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Audit } from '../common/decorators/audit.decorator';
import { EventSeverity } from '../security/entities/security-event.entity';
import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  ApplyVoucherDto,
  CreateOrderDto,
  CreateTicketTypeDto,
  PayOrderDto,
  QuoteOrderDto,
  UpdateTicketTypeDto,
} from './dto/ticketing.dto';
import { TransferTicketDto } from './dto/transfer.dto';
import { paymentCountries, paymentOptionsFor } from './payment/payment-options';
import { TicketingService } from './ticketing.service';
import { TicketTransferService } from './ticket-transfer.service';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';

/**
 * Ticketing: tiers per edition, orders, payment and the issued tickets the
 * app's My Ticket tab shows. Money is computed here only (TR-02).
 */
@ApiTags('ticketing')
@ApiBearerAuth()
@Controller()
export class TicketingController {
  constructor(
    private readonly service: TicketingService,
    private readonly transfers: TicketTransferService,
  ) {}

  @Get('editions/:id/ticket-types')
  @ApiOperation({
    summary: 'Ticket tiers on sale for an edition (pricing tab)',
  })
  ticketTypes(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.ticketTypes(id);
  }

  @Get('editions/:id/ticket-types/all')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({
    summary:
      'Every ticket tier of an edition, including tiers off sale (organisers)',
  })
  @ApiResponse({ status: 404, description: 'No such edition' })
  allTicketTypes(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.allTicketTypes(id);
  }

  @Post('editions/:id/ticket-types')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Add a ticket tier to an edition' })
  createTicketType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTicketTypeDto,
  ) {
    return this.service.createTicketType(id, dto);
  }

  @Patch('ticket-types/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'ticketType' })
  @ApiOperation({
    summary: 'Edit a ticket tier: price, perks, capacity, active',
  })
  updateTicketType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketTypeDto,
  ) {
    return this.service.updateTicketType(id, dto);
  }

  @Get('payments/countries')
  @ApiOperation({
    summary: 'Countries a delegate can pay from, with their currency',
  })
  countries() {
    return paymentCountries();
  }

  @Get('payments/options')
  @ApiOperation({
    summary:
      'Currency, provider and methods for a billing country (default NG)',
  })
  options(@Query('country') country?: string) {
    return paymentOptionsFor(country);
  }

  @Post('orders/quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price a basket without creating an order' })
  @ApiResponse({
    status: 400,
    description: 'Tier not on sale, sold out, or bad voucher',
  })
  quote(@Body() dto: QuoteOrderDto) {
    return this.service.quote(dto);
  }

  @Post('orders')
  @ApiOperation({ summary: 'Create a pending order for the caller' })
  createOrder(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) {
    return this.service.createOrder(user.id, dto);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: "One of the caller's orders" })
  order(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.getOrder(id, user.id);
  }

  @Post('orders/:id/voucher')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply or clear a voucher on a pending order' })
  applyVoucher(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyVoucherDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.applyVoucher(id, user.id, dto);
  }

  @Post('orders/:id/pay')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Charge the order; tickets are issued once the provider settles',
  })
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.pay(id, user.id, dto.method);
  }

  @Get('orders/:id/verify')
  @ApiOperation({
    summary:
      'After a hosted checkout: ask the provider, settle if paid, return the order',
  })
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.verifyPayment(id, user.id);
  }

  @Public()
  @Post('payments/paystack/webhook')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paystack webhook (signed; settles charge.success)',
  })
  @ApiResponse({ status: 400, description: 'Bad signature' })
  paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    return this.service.paymentWebhook('paystack', req.rawBody, signature);
  }

  @Public()
  @Post('payments/flutterwave/webhook')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Flutterwave webhook (verif-hash; charge.completed is re-verified with Flutterwave before settling)',
  })
  @ApiResponse({ status: 400, description: 'Wrong verif-hash' })
  flutterwaveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('verif-hash') signature?: string,
  ) {
    return this.service.paymentWebhook('flutterwave', req.rawBody, signature);
  }

  @Public()
  @Post('payments/stripe/webhook')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stripe webhook (signed; settles checkout.session.completed)',
  })
  @ApiResponse({ status: 400, description: 'Bad or stale signature' })
  stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.service.paymentWebhook('stripe', req.rawBody, signature);
  }

  @Get('tickets/me')
  @ApiOperation({ summary: "The caller's issued tickets, newest first" })
  myTickets(@CurrentUser() user: AuthUser) {
    return this.service.myTickets(user.id);
  }

  @Get('tickets/:id')
  @ApiOperation({ summary: "One of the caller's tickets" })
  ticket(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.ticket(id, user.id);
  }

  @Post('tickets/:id/transfer')
  @HttpCode(200)
  // a handful a minute is plenty for correcting a name; more is someone probing emails
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Audit({
    type: 'ticket_transferred',
    description: 'Buyer passed a gift ticket to someone else',
    severity: EventSeverity.WARNING,
  })
  @ApiOperation({
    summary:
      'Change who a ticket you bought for someone else is for; the previous QR stops admitting',
  })
  @ApiResponse({
    status: 200,
    description: 'The ticket as the buyer now sees it',
  })
  @ApiResponse({
    status: 400,
    description:
      'Already admitted on, event over, already for that person, or they already hold a ticket to the event',
  })
  @ApiResponse({ status: 403, description: 'Not the buyer of this ticket' })
  async transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.transfers.transfer(id, user.id, dto);
    return this.service.ticket(id, user.id);
  }
}
