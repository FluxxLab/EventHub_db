export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailSender {
  /** `html`, when given, is the formatted version; `text` is always sent too, for mail apps that show no HTML. */
  send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    /** Extra headers, such as List-Unsubscribe on campaign emails. */
    headers?: Record<string, string>,
  ): Promise<void>;
}
