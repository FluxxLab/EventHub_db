import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { RefreshToken } from './entities/refresh-token.entity';
import * as bcrypt from 'bcrypt';
import { TICKET_HOLDER_TAG } from '../ticketing/ticket-holders';
import { randomBytes, randomUUID } from 'crypto';
import { DelegatesService } from '../delegate/delegates.service';
import { AccessTier, Delegate } from '../delegate/entities/delegate.entity';
import { REDIS } from '../common/redis/redis.module';
import Redis from 'ioredis';
import { EventSeverity } from '../security/entities/security-event.entity';
import { SecurityService } from '../security/security.service';
import { RegisterDto } from './dto/register.dto';
import type { RegistrationPrefill } from './dto/prefill.dto';
import { OtpService } from './otp.service';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';
import type { GoogleIdentity } from './google-id-token.verifier';

interface RequestContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly delegate: DelegatesService,
    private readonly otpService: OtpService,

    @Inject(REDIS)
    private readonly redis: Redis,
    private readonly securityService: SecurityService,
    private readonly google: GoogleIdTokenVerifier,
  ) {}

  async login(rawEmail: string, password: string, ctx: RequestContext) {
    // Registration stores the address lower-cased; login has to match it the
    // same way. An iPad keyboard capitalising the first letter was enough to
    // lock App Review out of the demo account.
    const email = rawEmail.trim().toLowerCase();
    const delegate = await this.delegate.findByEmailForAuth(email);

    /**
     * Same error for invalid email and  password
     * do not leak which
     */
    // Exact first; then without surrounding whitespace, because a tablet
    // keyboard appends a space after an autocompleted word and a password
    // typed correctly plus one invisible character must still work. A
    // password that genuinely ends in a space still matches on the first try.
    const matches =
      !!delegate &&
      ((await bcrypt.compare(password, delegate.passwordHash)) ||
        (password !== password.trim() &&
          (await bcrypt.compare(password.trim(), delegate.passwordHash))));
    if (!matches) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issueTokens(delegate, ctx);
  }

  async refresh(refreshToken: string, ctx: RequestContext) {
    let payload: { sub: string; jti: string; typ: string };

    try {
      payload = this.jwt.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    const row = await this.refreshTokenRepository.findOneBy({
      jti: payload.jti,
    });

    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (row.consumedAt) {
      /**
       * reuse of an already rotated token = theft signal (TR-12):
       * revoke everyting this user holds and audits it
       */
      await this.refreshTokenRepository.update(
        { userId: row.userId, revokedAt: IsNull(), consumedAt: IsNull() },
        { revokedAt: new Date() },
      );

      /**
       * TODO(security module ):  write  Security Event{ type: 'refresh_token_reuse', actor: row.userId }
       */
      if (row.consumedAt) {
        /**
         * reuse of an already rotated token = theft signal
         * revoke everything this user holds and audit it
         */
        await this.refreshTokenRepository.update(
          { userId: row.userId, revokedAt: IsNull(), consumedAt: IsNull() },
          { revokedAt: new Date() },
        );

        await this.securityService.record({
          type: 'refresh_token_reuse',
          description:
            'Refresh token reuse detected - all tokens for user revoked',
          actorId: row.userId,
          severity: EventSeverity.CRITICAL,
        });
        throw new UnauthorizedException('Refresh token reuse detected');
      }
    }

    const delegate = await this.delegate.findById(row.userId);

    if (!delegate) throw new UnauthorizedException('User not found');

    const tokens = await this.issueTokens(delegate, ctx);

    await this.refreshTokenRepository.update(row.id, {
      consumedAt: new Date(),
      replacedByJti: tokens.refreshTokenId,
    });

    return tokens;
  }

  async logout(refreshToken: string, accessJti?: string, accessExp?: number) {
    try {
      const payload = await this.jwt.verifyAsync<{ jti: string }>(refreshToken);
      await this.refreshTokenRepository.update(
        { jti: payload.jti },
        { revokedAt: new Date() },
      );
    } catch {
      /**
       * Idemptent
       */
    }

    if (accessJti && accessExp) {
      const ttl = accessExp - Math.floor(Date.now() / 1000);

      if (ttl > 0) await this.redis.set(`bl:${accessJti}`, '1', 'EX', ttl);
    }
  }

  private async issueTokens(delegate: Delegate, ctx: RequestContext) {
    const accessTtl = this.config.getOrThrow<number>('JWT_ACCESS_TTL');
    const refreshTtl = this.config.getOrThrow<number>('JWT_REFRESH_TTL');
    const refreshJti = randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: delegate.id, role: delegate.accessTier, jti: randomUUID() },
      { expiresIn: accessTtl },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: delegate.id, typ: 'refresh', jti: refreshJti },
      { expiresIn: refreshTtl },
    );

    await this.refreshTokenRepository.save(
      this.refreshTokenRepository.create({
        userId: delegate.id,
        jti: refreshJti,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      }),
    );

    return {
      accessToken,
      refreshToken,
      refreshTokenId: refreshJti,
    };
  }

  /**
   * Anti-enumeration by design: the response is identical whether the email
   * has an account or not. The OTP email is only actually sent when one
   * exists, so an attacker probing addresses learns nothing from this route.
   */
  async forgotPassword(rawEmail: string): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    const delegate = await this.delegate.findByEmailForAuth(email);
    if (!delegate) return;
    // A placeholder account's password is a secret nobody holds, and its
    // email is a guess at a public mailbox that may belong to a real
    // stranger - a reset code must never land in it. The tag is checked too:
    // a row seeded before `hasChosenPassword` existed still only carries
    // that legacy marker, and nothing back-fills the column onto it.
    // An unclaimed ticket-holder account is the exception: the buyer typed
    // that address for this person, and a reset code only proves the inbox,
    // which is exactly how it gets claimed.
    // A Google sign-in account has no password it chose either, but Google
    // proved the inbox when it was created, so a reset is how it gets one.
    const holder = delegate.tags?.includes(TICKET_HOLDER_TAG);
    if (
      (!delegate.hasChosenPassword && !holder && !delegate.googleSub) ||
      delegate.tags?.includes('seed')
    )
      return;
    await this.otpService.requestOtp(
      email,
      'email',
      undefined,
      'password reset',
    );
  }

  /**
   * The OTP is the credential here - it proves inbox control, the same proof
   * registration relies on. On success every live refresh token is revoked:
   * a reset that leaves stolen sessions signed in would defeat its own point.
   */
  async resetPassword(
    rawEmail: string,
    otp: string,
    newPassword: string,
  ): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    await this.otpService.assertValid(email, otp);

    const delegate = await this.delegate.findByEmailForAuth(email);
    // Generic message on purpose: a distinct "no such account" here would leak
    // what forgotPassword deliberately hides.
    if (!delegate) throw new BadRequestException('Invalid or expired code');

    await this.delegate.updatePassword(
      delegate.id,
      await bcrypt.hash(newPassword, 12),
    );
    await this.otpService.consume(email);
    await this.refreshTokenRepository.update(
      { userId: delegate.id, revokedAt: IsNull(), consumedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /**
   * What the sign-up form can fill in from a printed invite code.
   *
   * Public and unauthenticated, so it says as little as it can: one 404 for
   * a code that was never issued and one that has been claimed, because the
   * difference tells a guesser which codes are live. The values it does
   * return are what the organiser printed on the invitation anyway.
   */
  async registrationPrefill(rawCode: string): Promise<RegistrationPrefill> {
    const code = rawCode.trim();
    const entry = code ? await this.delegate.matchRegistration('', code) : null;
    if (!entry) {
      throw new NotFoundException(
        'That code has already been used or does not exist',
      );
    }
    return {
      email: entry.email,
      name: entry.name,
      organisation: entry.organisation,
      title: entry.title,
    };
  }

  async registration(dto: RegisterDto, ctx: RequestContext) {
    const email = dto.email.toLowerCase();

    if (dto.consent !== true) {
      throw new BadRequestException(
        'consent must be explicitly true (boolean) to register',
      );
    }

    const verifiedVia = await this.otpService.assertValid(email, dto.otp);

    // Someone else paid for this person's ticket and an account was made for
    // it at settlement. The code just proved the inbox is theirs, so signing
    // up takes that account over (with their tickets) instead of refusing.
    const existing = await this.delegate.findByEmailForAuth(email);
    const claimable =
      !!existing &&
      !existing.hasChosenPassword &&
      (existing.tags ?? []).includes(TICKET_HOLDER_TAG);
    if (existing && !claimable) {
      throw new ConflictException('An account with this email already exists');
    }
    // Taking over a ticket-holder account hands its tickets to whoever signs
    // up, so it needs proof of the inbox the ticket was sent to. An SMS code
    // only proves a phone, and the phone is whatever the requester typed.
    if (claimable && verifiedVia !== 'email') {
      throw new BadRequestException(
        'A ticket is waiting for this email - please verify using the email code option',
      );
    }

    const entry = await this.delegate.matchRegistration(email, dto.inviteCode);
    if (dto.inviteCode && !entry) {
      throw new BadRequestException('Invalid or already-used invite code');
    }

    // tier-by-email-match demands inbox proof — SMS possession is not that proof
    const matchedByEmail = entry && !dto.inviteCode;
    if (matchedByEmail && verifiedVia !== 'email') {
      throw new BadRequestException(
        'This email is pre-registered — please verify using the email code option',
      );
    }

    const profile = {
      name: dto.name,
      email,
      passwordHash: await bcrypt.hash(dto.password, 12),
      accessTier: entry?.assignedTier ?? AccessTier.STANDARD,
      /**
       * Everyone who registers is in.
       *
       * The gate was built for a curated guest list: anyone whose email did
       * not match the registration list waited for an organiser to approve
       * them. In the hall on the day that meant delegates standing at the
       * desk unable to open the app while someone found a laptop, so it is
       * off. The registration list still decides the access tier, which is
       * what actually controls what a delegate can see; an organiser can
       * still withdraw access afterwards from the Delegates page.
       */
      pendingReview: false,
      phone: dto.phone ?? null,
      // What the invitee typed wins; what the organiser put on the list fills
      // the gap. The form prefills from the same entry, so a delegate who
      // cleared the field and submitted is the one case this overrides -
      // and an organisation the organiser named is the better record.
      organisation: dto.organisation?.trim() || entry?.organisation || null,
      title: dto.title?.trim() || entry?.title || null,
      consentAt: new Date(),
    };
    const delegate =
      existing && claimable
        ? await this.delegate.claimHolderAccount(existing.id, {
            name: profile.name,
            passwordHash: profile.passwordHash,
            accessTier: profile.accessTier,
            phone: profile.phone,
            organisation: profile.organisation,
            title: profile.title,
            consentAt: profile.consentAt,
          })
        : await this.delegate.createDelegate(profile);

    if (entry) await this.delegate.claimRegistration(entry.id, delegate.id);
    // the account exists; only now is the code spent
    await this.otpService.consume(email);

    await this.securityService.record({
      type: 'delegate_registered',
      description: claimable
        ? 'Claimed the account created for a ticket someone else bought'
        : entry
          ? `Registration matched list entry — tier ${delegate.accessTier} granted`
          : 'Unmatched registration — standard tier, pending review',
      actorId: delegate.id,
      severity: EventSeverity.INFO,
      metadata: { matched: !!entry, tier: delegate.accessTier, verifiedVia },
    });

    return this.issueTokens(delegate, ctx);
  }

  /**
   * A signed-in delegate changing their password. The current one is asked
   * for so a borrowed unlocked phone cannot lock its owner out. Every other
   * session is signed out (all live refresh tokens revoked) and this device
   * gets a fresh pair, so the caller stays signed in.
   */
  async changePassword(
    delegateId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ) {
    const hash = await this.delegate.passwordHashFor(delegateId);
    if (!hash) throw new UnauthorizedException('User not found');
    // same trailing-space tolerance as login
    const matches =
      (await bcrypt.compare(currentPassword, hash)) ||
      (currentPassword !== currentPassword.trim() &&
        (await bcrypt.compare(currentPassword.trim(), hash)));
    if (!matches) {
      throw new BadRequestException('Your current password is incorrect');
    }

    // updatePassword also marks the password as chosen
    await this.delegate.updatePassword(
      delegateId,
      await bcrypt.hash(newPassword, 12),
    );
    await this.refreshTokenRepository.update(
      { userId: delegateId, revokedAt: IsNull(), consumedAt: IsNull() },
      { revokedAt: new Date() },
    );
    await this.securityService.record({
      type: 'password_changed',
      description: 'Password changed; every other session signed out',
      actorId: delegateId,
      severity: EventSeverity.INFO,
    });

    const delegate = await this.delegate.findById(delegateId);
    if (!delegate) throw new UnauthorizedException('User not found');
    return this.issueTokens(delegate, ctx);
  }

  /**
   * Sign in, or sign up, with a Google ID token.
   *
   * Google has verified the email, which is the same proof registration's
   * email code gives, so it is treated the same way: it may claim an
   * unclaimed ticket-holder account and it earns a registration-list tier by
   * email. Creating or claiming an account needs consent, exactly as
   * registration does; the app asks and resends with `consent: true` when
   * this answers `code: 'consent_required'`.
   */
  async googleSignIn(
    idToken: string,
    consent: boolean | undefined,
    ctx: RequestContext,
  ) {
    const identity = await this.google.verify(idToken);

    const linked = await this.delegate.findByGoogleSub(identity.sub);
    if (linked) return this.issueTokens(linked, ctx);

    const existing = await this.delegate.findByEmailForAuth(identity.email);
    if (!existing) return this.googleCreateOrClaim(identity, consent, ctx);

    if (existing.googleSub) {
      // the address now belongs to a different Google account than the one
      // this delegate signed in with before
      throw new UnauthorizedException(
        'This account is linked to a different Google account',
      );
    }
    const holder =
      !existing.hasChosenPassword &&
      (existing.tags ?? []).includes(TICKET_HOLDER_TAG);
    if (holder) {
      return this.googleCreateOrClaim(identity, consent, ctx, existing);
    }
    // A seeded placeholder's email is a guess at somebody's mailbox;
    // registration will not hand it over and neither does Google.
    if (!existing.hasChosenPassword || existing.tags?.includes('seed')) {
      throw new ConflictException('An account with this email already exists');
    }
    await this.delegate.linkGoogle(existing.id, identity.sub);
    await this.securityService.record({
      type: 'google_linked',
      description: 'Google sign-in linked to an existing account',
      actorId: existing.id,
      severity: EventSeverity.INFO,
    });
    return this.issueTokens(existing, ctx);
  }

  private async googleCreateOrClaim(
    identity: GoogleIdentity,
    consent: boolean | undefined,
    ctx: RequestContext,
    holder?: Delegate,
  ) {
    if (consent !== true) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Accept the terms to create your account',
        code: 'consent_required',
      });
    }

    // Google verified the inbox, so an email match on the list counts
    const entry = await this.delegate.matchRegistration(identity.email);
    const name = identity.name ?? holder?.name ?? identity.email.split('@')[0];
    // a password nobody knows; reset-password is how they get a real one
    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const accessTier = entry?.assignedTier ?? AccessTier.STANDARD;
    const consentAt = new Date();

    const delegate = holder
      ? await this.delegate.claimHolderAccount(holder.id, {
          name,
          passwordHash,
          accessTier,
          phone: holder.phone ?? null,
          organisation: holder.organisation ?? entry?.organisation ?? null,
          title: holder.title ?? entry?.title ?? null,
          consentAt,
          hasChosenPassword: false,
          googleSub: identity.sub,
        })
      : await this.delegate.createDelegate({
          name,
          email: identity.email,
          passwordHash,
          accessTier,
          pendingReview: false,
          phone: null,
          organisation: entry?.organisation ?? null,
          title: entry?.title ?? null,
          consentAt,
          hasChosenPassword: false,
          googleSub: identity.sub,
        });

    if (entry) await this.delegate.claimRegistration(entry.id, delegate.id);

    await this.securityService.record({
      type: 'delegate_registered',
      description: holder
        ? 'Claimed the account created for a ticket someone else bought (Google)'
        : entry
          ? `Google registration matched list entry — tier ${delegate.accessTier} granted`
          : 'Google registration — standard tier',
      actorId: delegate.id,
      severity: EventSeverity.INFO,
      metadata: {
        matched: !!entry,
        tier: delegate.accessTier,
        verifiedVia: 'google',
      },
    });

    return this.issueTokens(delegate, ctx);
  }
}
