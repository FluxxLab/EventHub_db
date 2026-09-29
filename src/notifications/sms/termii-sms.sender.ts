import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SmsSender } from './sms-sender.interface';

@Injectable()
export class TermiiSmsSender implements SmsSender {
  private readonly logger = new Logger(TermiiSmsSender.name);

  constructor(private readonly config: ConfigService) {}

  async send(toPhone: string, text: string): Promise<void> {
    try {
      const res = await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.config.getOrThrow('TERMII_API_KEY'),
          to: toPhone,
          from: this.config.getOrThrow('TERMII_SENDER_ID'),
          sms: text,
          type: 'plain',
          /**
           * 'dnd', not 'generic': Nigerian carriers silently drop generic-route
           * messages to lines with Do-Not-Disturb active (MTN enables it by
           * default), and Termii's log just sits at SENT with no receipt. The
           * DND route is carrier-whitelisted and reaches those lines. Costs a
           * little more per SMS, but an OTP that never lands is a delegate who
           * cannot register.
           */
          channel: 'dnd',
        }),
      });

      // Termii can answer HTTP 200 with a non-ok `code` (e.g. insufficient
      // balance), so check the body as well as the status.
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message_id?: string;
        balance?: number;
        message?: string;
      };

      if (!res.ok || body.code !== 'ok') {
        this.logger.error(
          `Termii send failed (${res.status}): ${JSON.stringify(body)}`,
        );
        throw new Error(
          `SMS delivery failed: Termii ${body.message ?? res.status}`,
        );
      }

      // message_id is what you search for in Termii's Signal Log.
      this.logger.log(
        `Termii accepted sms to ${toPhone}: id=${body.message_id} balance=${body.balance}`,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith('SMS delivery failed')
      ) {
        throw err;
      }
      this.logger.error(`Termii network/unknown error: ${err}`);
      throw new Error('SMS delivery failed: network error');
    }
  }
}
