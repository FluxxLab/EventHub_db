export const SMS_SENDER = 'SMS_SENDER';

export interface SmsSender {
  send(toPhone: string, text: string): Promise<void>;
}
