import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import type { PushData, PushSender, PushTarget } from './push-sender.interface';
import { pushDataPayload } from './push-sender.interface';
import { App, cert } from 'firebase-admin';
import { getMessaging } from 'firebase-admin/messaging';

@Injectable()
export class FcmPushSender implements PushSender {
  private readonly logger = new Logger(FcmPushSender.name);
  private readonly app: App;

  constructor(config: ConfigService) {
    this.app = admin.initializeApp({
      credential: cert({
        projectId: config.getOrThrow('FIREBASE_PROJECT_ID'),
        clientEmail: config.getOrThrow('FIREBASE_CLIENT_EMAIL'),
        privateKey: config
          .getOrThrow<string>('FIREBASE_PRIVATE_KEY')
          .replace(/\\n/g, '\n'),
      }),
    });
  }

  async sendToTokens(
    targets: PushTarget[],
    title: string,
    body: string,
    data?: PushData,
  ) {
    const tokens = targets.map((t) => t.token);
    const invalidTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);

      const res = await getMessaging(this.app).sendEachForMulticast({
        tokens: batch,
        notification: {
          title,
          body,
        },
        // FCM only carries string values here, hence pushDataPayload
        data: pushDataPayload(data),
      });

      res.responses.forEach((r, idx) => {
        if (
          !r.success &&
          r.error?.code ===
            'messaging/invalid-registration-token-not-registered'
        ) {
          invalidTokens.push(batch[idx]);
        }
      });
    }
    return { invalidTokens };
  }
}
