import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * Development stand-in: settles every charge at once and logs it. Free orders
 * also come through here in every environment, since nothing is charged,
 * and so does any order whose provider has no key set (see PaymentRouter).
 */
@Injectable()
export class LogPaymentProvider implements PaymentProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogPaymentProvider');

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const reference = `${request.method}-${randomUUID().slice(0, 8)}`;
    this.logger.log(
      `[dev] would charge ${request.currency} ${request.amount} by ${request.method} for order ${request.orderId} (${reference})`,
    );
    return { reference, status: 'paid' };
  }
}
