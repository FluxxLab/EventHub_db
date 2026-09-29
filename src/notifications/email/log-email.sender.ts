import { Injectable, Logger } from '@nestjs/common';
import type { EmailSender } from './email-sender.interface';

@Injectable()
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('LogEmailSender');

  async send(to: string, subject: string, text: string): Promise<void> {
    this.logger.log(`[dev] email to ${to}: ${subject} - ${text}`);
  }
}
