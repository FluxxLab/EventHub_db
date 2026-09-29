import { Injectable, Logger } from '@nestjs/common';
import type { SmsSender } from './sms-sender.interface';

@Injectable()
export class LogSmsSender implements SmsSender {
  private readonly logger = new Logger('LogSmsSender');

  async send(toPhone: string, text: string): Promise<void> {
    this.logger.log(`[dev] sms to ${toPhone}: ${text}`);
  }
}
