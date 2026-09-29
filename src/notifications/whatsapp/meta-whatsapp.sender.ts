import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  templateText,
  waNumber,
  type WhatsAppSender,
} from './whatsapp-sender.interface';

/** The Graph API version the Cloud API calls are pinned to. */
export const GRAPH_VERSION = 'v21.0';

/**
 * Meta's WhatsApp Cloud API: POST /{phone-number-id}/messages with an
 * approved template. Needs WHATSAPP_TOKEN (a system-user access token) and
 * WHATSAPP_PHONE_NUMBER_ID from the WhatsApp Business account.
 */
export class MetaWhatsAppSender implements WhatsAppSender {
  readonly live = true;
  private readonly logger = new Logger(MetaWhatsAppSender.name);
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly template: string;
  private readonly language: string;

  constructor(
    config: ConfigService,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.token = config.getOrThrow<string>('WHATSAPP_TOKEN');
    this.phoneNumberId = config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER_ID');
    this.template =
      config.get<string>('WHATSAPP_ANNOUNCEMENT_TEMPLATE') ||
      'pic_announcement';
    this.language = config.get<string>('WHATSAPP_TEMPLATE_LANGUAGE') || 'en';
  }

  async sendAnnouncement(phone: string, title: string, body: string) {
    const res = await this.fetcher(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: waNumber(phone),
          type: 'template',
          template: {
            name: this.template,
            language: { code: this.language },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: templateText(title, 120) },
                  { type: 'text', text: templateText(body, 700) },
                ],
              },
            ],
          },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(
        `WhatsApp send failed (${res.status}): ${detail.slice(0, 300)}`,
      );
      throw new Error(`WhatsApp send failed with ${res.status}`);
    }
  }
}
