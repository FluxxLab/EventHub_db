import { BullModule } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DelegateModule } from '../delegate/delegate.module';
import { DeviceToken } from './entities/device-token.entity';
import { Notification } from './entities/notification.entity';
import { NotificationRead } from './entities/notification-read.entity';
import { NotificationsController } from './notifications.controller';
import {
  NOTIFICATIONS_FLOW,
  NotificationsProcessor,
} from './notifications.processor';
import { NotificationsService } from './notifications.service';
import { ApnsPushSender } from './push/apns-push.sender';
import { FcmPushSender } from './push/fcm-push.sender';
import { LogPushSender } from './push/log-push.sender';
import { PUSH_SENDER } from './push/push-sender.interface';
import { RoutingPushSender } from './push/routing-push.sender';
import { EMAIL_SENDER } from './email/email-sender.interface';
import { LogEmailSender } from './email/log-email.sender';
import { SmtpEmailSender } from './email/smtp-email.sender';
import { ZeptoEmailSender } from './email/zepto-email.sender';
import { SMS_SENDER } from './sms/sms-sender.interface';
import { LogWhatsAppSender } from './whatsapp/log-whatsapp.sender';
import { MetaWhatsAppSender } from './whatsapp/meta-whatsapp.sender';
import { WHATSAPP_SENDER } from './whatsapp/whatsapp-sender.interface';
import { LogSmsSender } from './sms/log-sms.sender';
import { TermiiSmsSender } from './sms/termii-sms.sender';
import { NotificationsGateway } from './notifications.gateway';

const logger = new Logger('NotificationsModule');

/**
 * ZeptoMail needs a token and a verified sender address. Warns rather than
 * failing quietly when the token is set but the address is not: a half
 * configured provider that silently falls back to logging is how OTP emails
 * stop arriving without anyone noticing.
 */
function hasZeptoMail(config: ConfigService): boolean {
  const token = config.get('ZEPTOMAIL_TOKEN');
  if (!token) return false;

  if (!config.get('ZEPTOMAIL_FROM_ADDRESS')) {
    logger.warn(
      'ZEPTOMAIL_TOKEN set but ZEPTOMAIL_FROM_ADDRESS is missing. Falling back.',
    );
    return false;
  }
  return true;
}

function hasAllSmtp(config: ConfigService): boolean {
  const required = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
  ] as const;
  const missing = required.filter((k) => !config.get(k));
  if (missing.length > 0) {
    if (config.get('SMTP_HOST')) {
      logger.warn(
        `SMTP_HOST set but missing: ${missing.join(', ')}. Falling back to LogEmailSender.`,
      );
    }
    return false;
  }
  return true;
}

function hasAllTermii(config: ConfigService): boolean {
  const required = ['TERMII_API_KEY', 'TERMII_SENDER_ID'] as const;
  const missing = required.filter((k) => !config.get(k));
  if (missing.length > 0) {
    if (config.get('TERMII_API_KEY')) {
      logger.warn(
        `TERMII_API_KEY set but missing: ${missing.join(', ')}. Falling back to LogSmsSender.`,
      );
    }
    return false;
  }
  return true;
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, DeviceToken, NotificationRead]),
    BullModule.registerQueue({ name: 'notifications' }),
    // fans a segment broadcast out into per-chunk push jobs
    BullModule.registerFlowProducer({ name: NOTIFICATIONS_FLOW }),
    DelegateModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsProcessor,
    NotificationsGateway,
    {
      provide: PUSH_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // iOS registers a raw APNs token and Android an FCM one, so a
        // deployment that wants both needs both senders behind the router.
        const fcm = config.get('FIREBASE_PROJECT_ID')
          ? new FcmPushSender(config)
          : null;
        // All four APNs settings or none: a pasted key without its key id,
        // team id and bundle id would otherwise crash the whole API on start.
        const apnsKeys = [
          'APNS_KEY',
          'APNS_KEY_ID',
          'APNS_TEAM_ID',
          'APNS_BUNDLE_ID',
        ] as const;
        const apnsMissing = apnsKeys.filter((key) => !config.get(key));
        if (config.get('APNS_KEY') && apnsMissing.length > 0) {
          new Logger('NotificationsModule').warn(
            `iOS push is off: set ${apnsMissing.join(', ')} to turn it on.`,
          );
        }
        const apns =
          apnsMissing.length === 0 ? new ApnsPushSender(config) : null;

        if (fcm && apns) return new RoutingPushSender(apns, fcm);
        // Either alone still delivers to its own platform and silently drops
        // the other, which is what a half-configured environment gets today.
        return fcm ?? apns ?? new LogPushSender();
      },
    },
    {
      provide: EMAIL_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        // ZeptoMail first, SMTP as the fallback for anyone still on it, and
        // LogEmailSender last so local development needs no credentials.
        hasZeptoMail(config)
          ? new ZeptoEmailSender(config)
          : hasAllSmtp(config)
            ? new SmtpEmailSender(config)
            : new LogEmailSender(),
    },
    {
      provide: SMS_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Announce the choice at boot so "did the SMS leave the server?" is
        // answerable from the startup log alone.
        const real = hasAllTermii(config);
        logger.log(
          `SMS sender: ${real ? 'Termii' : 'LogSmsSender (dev stub - nothing is sent)'}`,
        );
        return real ? new TermiiSmsSender(config) : new LogSmsSender();
      },
    },
    {
      provide: WHATSAPP_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const real =
          !!config.get<string>('WHATSAPP_TOKEN') &&
          !!config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
        logger.log(
          `WhatsApp sender: ${real ? 'Meta Cloud API' : 'LogWhatsAppSender (dev stub - nothing is sent)'}`,
        );
        return real ? new MetaWhatsAppSender(config) : new LogWhatsAppSender();
      },
    },
  ],
  // NotificationsService is the door other domains knock on to send a push:
  // sessions announces a session going live through it.
  exports: [
    EMAIL_SENDER,
    SMS_SENDER,
    WHATSAPP_SENDER,
    NotificationsGateway,
    NotificationsService,
  ],
})
export class NotificationsModule {}
