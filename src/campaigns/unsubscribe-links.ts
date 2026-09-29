import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** 16 bytes of HMAC, base64url: enough that nobody can make one for an address they typed. */
const SIG_LENGTH = 22;

/**
 * Unsubscribe links in campaign emails. The token is the address and a
 * signature over it, so it needs no table to look up and cannot be edited
 * into someone else's. The link opens a confirmation page on the console
 * (a mail scanner opening every link must not unsubscribe anyone); with
 * PUBLIC_API_URL set, the mail app's own Unsubscribe button works too
 * (RFC 8058 one-click).
 */
@Injectable()
export class UnsubscribeLinks {
  constructor(private readonly config: ConfigService) {}

  private secret(): string {
    return (
      this.config.get<string>('UNSUBSCRIBE_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  private sign(email: string): string {
    return createHmac('sha256', this.secret())
      .update(`unsubscribe:${email}`)
      .digest('base64url')
      .slice(0, SIG_LENGTH);
  }

  token(email: string): string {
    const address = email.trim().toLowerCase();
    return `${Buffer.from(address).toString('base64url')}.${this.sign(address)}`;
  }

  /** The address a token was made for, or null when it is not one of ours. */
  verify(token: string | undefined): string | null {
    const [encoded, sig] = (token ?? '').trim().split('.');
    if (!encoded || !sig) return null;
    const email = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
    const expected = Buffer.from(this.sign(email));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? email
      : null;
  }

  /** Where the console lives; campaigns are not sent without it, since every one needs the link. */
  consoleUrl(): string | null {
    return (
      this.config.get<string>('PUBLIC_CONSOLE_URL')?.replace(/\/+$/, '') || null
    );
  }

  /** The confirmation page for this address. */
  pageUrl(email: string): string {
    return `${this.consoleUrl()}/unsubscribe?t=${this.token(email)}`;
  }

  /** List-Unsubscribe headers, for the mail app's own button; none without a public API address. */
  headers(email: string): Record<string, string> {
    const api = this.config.get<string>('PUBLIC_API_URL')?.replace(/\/+$/, '');
    if (!api) return {};
    return {
      'List-Unsubscribe': `<${api}/email/unsubscribe/one-click?t=${this.token(email)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
}
