import { Logger } from '@nestjs/common';
import type { WhatsAppSender } from './whatsapp-sender.interface';

/** Development stub: logs what would have gone to WhatsApp and sends nothing. */
export class LogWhatsAppSender implements WhatsAppSender {
  readonly live = false;
  private readonly logger = new Logger(LogWhatsAppSender.name);

  sendAnnouncement(phone: string, title: string): Promise<void> {
    this.logger.log(
      `[stub] WhatsApp to ${phone.slice(0, -4).replace(/\d/g, '*')}${phone.slice(-4)}: "${title}"`,
    );
    return Promise.resolve();
  }
}
