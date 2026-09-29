import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

const SIG_LENGTH = 22;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open and click tracking in campaign emails. An open is a 1×1 image unique
 * to the recipient; a click goes through a redirect that is signed over the
 * recipient and the destination together, so the redirect can only ever send
 * people where the email itself linked (never an open redirect for anyone
 * who edits the address). Both need PUBLIC_API_URL; without it, emails go
 * out untracked.
 */
@Injectable()
export class TrackingLinks {
  constructor(private readonly config: ConfigService) {}

  private secret(): string {
    return (
      this.config.get<string>('UNSUBSCRIBE_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET')
    );
  }

  private sign(message: string): string {
    return createHmac('sha256', this.secret())
      .update(message)
      .digest('base64url')
      .slice(0, SIG_LENGTH);
  }

  private matches(message: string, sig: string | undefined): boolean {
    if (!sig) return false;
    const expected = Buffer.from(this.sign(message));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  apiUrl(): string | null {
    return (
      this.config.get<string>('PUBLIC_API_URL')?.replace(/\/+$/, '') || null
    );
  }

  enabled(): boolean {
    return !!this.apiUrl();
  }

  pixelUrl(recipientId: string): string {
    return `${this.apiUrl()}/email/o/${recipientId}.${this.sign(`open:${recipientId}`)}.gif`;
  }

  clickUrl(recipientId: string, url: string): string {
    const sig = this.sign(`click:${recipientId}:${url}`);
    return `${this.apiUrl()}/email/c/${recipientId}.${sig}?u=${encodeURIComponent(url)}`;
  }

  /** The recipient an open image was made for, or null. */
  verifyOpen(token: string): string | null {
    const [id, sig] = token.replace(/\.gif$/, '').split('.');
    return id && UUID.test(id) && this.matches(`open:${id}`, sig) ? id : null;
  }

  /** The recipient a click redirect was made for, when the destination is the one it was signed for. */
  verifyClick(token: string, url: string | undefined): string | null {
    const [id, sig] = token.split('.');
    if (!id || !url || !UUID.test(id) || !/^https?:\/\//i.test(url))
      return null;
    return this.matches(`click:${id}:${url}`, sig) ? id : null;
  }
}
