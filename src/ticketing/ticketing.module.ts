import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsModule } from '../editions/editions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdmissionController } from './admission.controller';
import { AdmissionService } from './admission.service';
import { BadgesController } from './badges.controller';
import { BadgesService } from './badges.service';
import { IssueService } from './issue.service';
import { StorageService } from '../common/storage/storage.service';
import { Order } from './entities/order.entity';
import { TicketAdmission } from './entities/ticket-admission.entity';
import { TicketType } from './entities/ticket-type.entity';
import { Ticket } from './entities/ticket.entity';
import { Voucher } from './entities/voucher.entity';
import { LogPaymentProvider } from './payment/log-payment.provider';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { PaymentRouter } from './payment/payment-router';
import { PaystackProvider } from './payment/paystack.provider';
import { StripeProvider } from './payment/stripe.provider';
import { FlutterwaveProvider } from './payment/flutterwave.provider';
import { TicketingController } from './ticketing.controller';
import { TicketingService } from './ticketing.service';
import { TicketTransferService } from './ticket-transfer.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TicketType,
      Order,
      Ticket,
      Voucher,
      TicketAdmission,
    ]),
    EditionsModule,
    // EMAIL_SENDER, to tell ticket holders someone bought them a ticket
    NotificationsModule,
  ],
  controllers: [TicketingController, AdmissionController, BadgesController],
  providers: [
    TicketingService,
    TicketTransferService,
    AdmissionService,
    BadgesService,
    IssueService,
    // signs profile photos for badges and check-in desks
    StorageService,
    LogPaymentProvider,
    PaystackProvider,
    StripeProvider,
    FlutterwaveProvider,
    PaymentRouter,
    // Flutterwave for every country by default (PAYMENT_GATEWAY); the log provider (settles at once) when a key is unset.
    { provide: PAYMENT_PROVIDER, useExisting: PaymentRouter },
  ],
  exports: [TicketingService, AdmissionService],
})
export class TicketingModule {}
