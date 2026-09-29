import type { PushSender, PushTarget } from './push-sender.interface';

const NOTHING = { invalidTokens: [] as string[] };

/**
 * One announcement, two transports: iOS devices go to Apple directly, every
 * other platform through Firebase. Sent in parallel so a slow APNs connection
 * does not hold up Android delivery for the same notification.
 */
export class RoutingPushSender implements PushSender {
  constructor(
    private readonly apns: PushSender,
    private readonly fcm: PushSender,
  ) {}

  async sendToTokens(targets: PushTarget[], title: string, body: string) {
    const ios = targets.filter((t) => t.platform === 'ios');
    const rest = targets.filter((t) => t.platform !== 'ios');

    const [apple, firebase] = await Promise.all([
      ios.length ? this.apns.sendToTokens(ios, title, body) : NOTHING,
      rest.length ? this.fcm.sendToTokens(rest, title, body) : NOTHING,
    ]);

    return {
      invalidTokens: [...apple.invalidTokens, ...firebase.invalidTokens],
    };
  }
}
