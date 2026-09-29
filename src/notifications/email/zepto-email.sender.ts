import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailSender } from './email-sender.interface';

/**
 * ZeptoMail over its HTTP API rather than SMTP.
 *
 * Chosen over the SMTP transport because outbound port 587 is the first thing
 * a host blocks, and a transactional API gives per-message delivery errors
 * instead of a socket timeout. The OTP path is the only caller, so a message
 * that silently fails to send is a delegate who cannot register.
 *
 * This calls the API directly with fetch instead of the `zeptomail` package.
 * The package parses every response body as JSON on a promise chain it never
 * ties to the one it returns - so when Zepto answers a 401 with an empty body,
 * the parse failure becomes an *unhandled* rejection that the caller's
 * try/catch cannot see, and Node terminates the process. In production that
 * was: password-reset request -> crashed API -> 502 for everyone -> Docker
 * restart. Twenty lines of fetch is cheaper than a dependency that can take
 * the service down.
 */
@Injectable()
export class ZeptoEmailSender implements EmailSender {
  private readonly logger = new Logger(ZeptoEmailSender.name);
  private readonly url: string;
  private readonly token: string;
  private readonly from: { address: string; name: string };

  constructor(config: ConfigService) {
    this.url =
      config.get<string>('ZEPTOMAIL_URL') ??
      'https://api.zeptomail.com/v1.1/email';

    /**
     * Zepto authenticates with `Authorization: Zoho-enczapikey <key>`.
     *
     * The key itself never contains whitespace, so everything before the last
     * whitespace-separated chunk is prefix debris - and debris is what turns
     * up in real .env files: production carried `Zoho-Zoho-enczapikey <key>`,
     * a hand-pasted double prefix, and a naive startsWith check stacked a
     * third copy on top. Discarding everything but the key and attaching the
     * prefix exactly once accepts a bare key, a correctly prefixed one, and
     * any number of botched paste-jobs alike.
     */
    const raw = config.getOrThrow<string>('ZEPTOMAIL_TOKEN').trim();
    const key = raw.split(/\s+/).pop() ?? raw;
    this.token = `Zoho-enczapikey ${key}`;

    this.from = {
      // Must be an address on a domain verified in ZeptoMail, or every send
      // is rejected regardless of the token.
      address: config.getOrThrow<string>('ZEPTOMAIL_FROM_ADDRESS'),
      name: config.get<string>('ZEPTOMAIL_FROM_NAME') ?? 'GS-26 Summit',
    };
  }

  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [{ email_address: { address: to, name: to } }],
          subject,
          /**
           * Always the plain text. HTML only when the caller built it (campaign
           * emails, rendered with every organiser-typed value escaped); OTPs and
           * notices stay text, which cannot carry an injection.
           */
          textbody: text,
          ...(html ? { htmlbody: html } : {}),
          ...(headers && Object.keys(headers).length
            ? { mime_headers: headers }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // network failure or timeout - never the token or the body
      this.logger.error(
        `ZeptoMail unreachable sending to ${to}: ${String(err)}`,
      );
      throw new Error('Email delivery failed');
    }

    if (!response.ok) {
      /**
       * Read as text, never .json(): the empty or HTML error body is the
       * exact input that killed the previous implementation. The first slice
       * of it goes to the log because Zepto's real reason (bad token, domain
       * not verified, sandbox mode) lives there.
       */
      const body = await response.text().catch(() => '');
      this.logger.error(
        `ZeptoMail rejected send to ${to}: HTTP ${response.status} ${body.slice(0, 300)}`,
      );
      throw new Error('Email delivery failed');
    }
  }
}
