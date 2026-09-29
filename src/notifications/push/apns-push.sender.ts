import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification, Provider } from '@parse/node-apn';
import type { PushData, PushSender, PushTarget } from './push-sender.interface';
import { pushDataPayload } from './push-sender.interface';

/**
 * FR-08 delivery for iOS. The app registers with getDevicePushTokenAsync,
 * which on iOS returns a raw APNs device token rather than an FCM
 * registration token, so these devices cannot go through Firebase - they are
 * sent to Apple directly with the team's .p8 key.
 */
@Injectable()
export class ApnsPushSender implements PushSender, OnModuleDestroy {
  private readonly logger = new Logger(ApnsPushSender.name);
  private readonly provider: Provider;
  private readonly topic: string;

  constructor(config: ConfigService) {
    this.topic = config.getOrThrow('APNS_BUNDLE_ID');
    this.provider = new Provider({
      token: {
        // stored with escaped newlines, same convention as FIREBASE_PRIVATE_KEY
        key: config.getOrThrow<string>('APNS_KEY').replace(/\n/g, '\n'),
        keyId: config.getOrThrow('APNS_KEY_ID'),
        teamId: config.getOrThrow('APNS_TEAM_ID'),
      },
      // Only dev-client builds register against Apple's sandbox gateway; ad
      // hoc, TestFlight and App Store builds are all production.
      production: config.get('APNS_PRODUCTION') !== 'false',
    });
  }

  async sendToTokens(
    targets: PushTarget[],
    title: string,
    body: string,
    data?: PushData,
  ) {
    const tokens = targets.map((t) => t.token);
    if (tokens.length === 0) return { invalidTokens: [] };

    const note = new Notification();
    note.topic = this.topic;
    note.alert = { title, body };
    note.sound = 'default';
    note.pushType = 'alert';
    note.priority = 10;
    // a live-ops alert is worthless an hour after the fact
    note.expiry = Math.floor(Date.now() / 1000) + 3600;
    // rides alongside the alert; the app reads it when the banner is tapped
    note.payload = pushDataPayload(data);

    const res = await this.provider.send(note, tokens);

    /**
     * 410 Unregistered means the app was deleted; BadDeviceToken means the
     * token was never valid for this topic and environment. Both are
     * permanent, so the row goes - the same contract FcmPushSender has for
     * not-registered. Everything else (429, 500, connection resets) is
     * transient and the token is kept.
     */
    const invalidTokens: string[] = [];
    for (const f of res.failed) {
      const reason = f.response?.reason ?? f.error?.message;
      if (
        f.status === 410 ||
        reason === 'Unregistered' ||
        reason === 'BadDeviceToken'
      ) {
        invalidTokens.push(f.device);
      } else {
        this.logger.warn(
          `APNs ${f.status ?? '?'} for ${f.device}: ${reason ?? 'unknown error'}`,
        );
      }
    }

    this.logger.log(
      `APNs: ${res.sent.length} sent, ${res.failed.length} failed, ${invalidTokens.length} token(s) dropped`,
    );
    return { invalidTokens };
  }

  async onModuleDestroy() {
    await this.provider.shutdown();
  }
}
