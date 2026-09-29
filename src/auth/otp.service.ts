import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import Redis from 'ioredis';
import { REDIS } from '../common/redis/redis.module';
import { EMAIL_SENDER } from '../notifications/email/email-sender.interface';
import type { EmailSender } from '../notifications/email/email-sender.interface';
import { SMS_SENDER } from '../notifications/sms/sms-sender.interface';
import type { SmsSender } from '../notifications/sms/sms-sender.interface';

export type OtpChannel = 'email' | 'sms';

const OTP_TTL_SEC = 900;
const MAX_ATTEMPTS = 10;
const MAX_REQUESTS_PER_HOUR = 10;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
    @Inject(EMAIL_SENDER)
    private readonly email: EmailSender,
    @Inject(SMS_SENDER)
    private readonly sms: SmsSender,
  ) {}

  /**
   * `purpose` only changes the wording of the message. It defaults to
   * 'registration' so the registration SMS stays byte-identical to the
   * template submitted to Termii for sender-ID approval - password reset is
   * email-only, so its different wording never touches the SMS template.
   */
  async requestOtp(
    rawEmail: string,
    channel: OtpChannel,
    phone?: string,
    purpose: 'registration' | 'password reset' = 'registration',
  ): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    if (channel === 'sms' && !phone) {
      throw new BadRequestException(
        'Phone number is required for Sms verification',
      );
    }

    let requests: number;
    try {
      requests = await this.redis.incr(`otp:rate:${email}`);
      if (requests === 1) {
        await this.redis.expire(`otp:rate:${email}`, 3600);
      }
    } catch (err) {
      this.logger.error(`Redis rate limit failed for ${email}: ${err}`);
      throw new InternalServerErrorException('OTP service unavailable');
    }

    if (requests > MAX_REQUESTS_PER_HOUR) {
      throw new HttpException(
        'Too many requests - try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(100000, 1000000).toString();
    try {
      await this.redis.set(
        `otp:code:${email}`,
        JSON.stringify({ code, channel }),
        'EX',
        OTP_TTL_SEC,
      );
      await this.redis.del(`otp:attempts:${email}`);
    } catch (err) {
      this.logger.error(`Redis OTP store failed for ${email}: ${err}`);
      throw new InternalServerErrorException('OTP service unavailable');
    }

    const text = `Your GS-26 ${purpose} code is ${code}. it expires in 10 minutes`;

    try {
      if (channel === 'sms') {
        await this.sms.send(phone as string, text);
      } else {
        await this.email.send(email, 'Your GS-26 verification code', text);
      }
    } catch (err) {
      this.logger.error(`OTP ${channel} delivery failed for ${email}: ${err}`);
      throw new InternalServerErrorException(
        `Failed to send OTP via ${channel}. Please try again later.`,
      );
    }
  }

  /**
   * Check a code without spending it.
   *
   * The code used to be deleted here, on the first match. Registration
   * checks several other things after the code - that the email is not
   * already an account, that an invite code is real, that a pre-registered
   * email was verified by email - and any of those failing left the
   * delegate holding a code the server had already thrown away. Their next
   * try, with the same code from the same email, was "invalid or expired",
   * which is the opposite of what happened. So the check only reads; the
   * caller calls `consume` once the thing the code was for has succeeded.
   * Attempts are still counted here, so guessing stays capped.
   */
  async assertValid(rawEmail: string, rawCode: string): Promise<OtpChannel> {
    const email = rawEmail.toLowerCase().trim();
    const code = rawCode.trim();

    let attempts: number;
    try {
      attempts = await this.redis.incr(`otp:attempts:${email}`);
    } catch (err) {
      this.logger.error(`Redis attempts incr failed for ${email}: ${err}`);
      throw new InternalServerErrorException('OTP service unavailable');
    }

    if (attempts > MAX_ATTEMPTS) {
      try {
        await this.redis.del(`otp:code:${email}`);
      } catch {
        // ignore cleanup error
      }
      throw new HttpException(
        'Too many attempts - try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let stored: string | null;
    try {
      stored = await this.redis.get(`otp:code:${email}`);
    } catch (err) {
      this.logger.error(`Redis OTP lookup failed for ${email}: ${err}`);
      throw new InternalServerErrorException('OTP service unavailable');
    }

    if (!stored) {
      throw new BadRequestException('Invalid or expired code');
    }

    const parsed = JSON.parse(stored) as { code: string; channel: OtpChannel };
    if (parsed.code !== code) {
      throw new BadRequestException('Invalid or expired code');
    }

    return parsed.channel;
  }

  /** Spend the code: the action it authorised has succeeded. */
  async consume(rawEmail: string): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    try {
      await this.redis.del(`otp:code:${email}`, `otp:attempts:${email}`);
    } catch {
      // the code expires on its own; a failed cleanup is not worth failing
      // the registration that just succeeded
    }
  }
}
