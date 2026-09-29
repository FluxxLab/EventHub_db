export const WHATSAPP_SENDER = 'WHATSAPP_SENDER';

/**
 * WhatsApp messages to delegates who opted in. Business-initiated WhatsApp
 * messages must use a template Meta has approved in advance, so a sender
 * fills a named template's parameters rather than sending free text.
 */
export interface WhatsAppSender {
  /** False for the log stub: the console says so rather than promising delivery. */
  readonly live: boolean;
  /** An announcement: the approved template with the title and the message as its two parameters. */
  sendAnnouncement(phone: string, title: string, body: string): Promise<void>;
}

/**
 * Template parameters may not contain new lines, tabs or more than four
 * spaces in a row, and a template's text is capped at 1,024 characters, so
 * the organiser's text is flattened and trimmed to fit.
 */
export function templateText(value: string, max: number): string {
  const flat = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** WhatsApp addresses a number as digits with the country code, no plus. */
export const waNumber = (phone: string) => phone.replace(/[^0-9]/g, '');
