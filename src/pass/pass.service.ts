import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DelegatesService } from '../delegate/delegates.service';
import { EventSeverity } from '../security/entities/security-event.entity';
import { SecurityService } from '../security/security.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { DelegateDirectoryDto } from '../delegate/dto/delegate-directory.dto';

/**
 * FR-07: the QR pass a delegate shows at a gate.
 *
 * Signed with its own ECDSA keypair rather than JWT_SECRET, for two reasons.
 *
 * The first is separation. A pass is meant to be displayed on a screen and
 * photographed by strangers; an access token is a secret. When both are signed
 * by the same key, only a claim check stands between them, and this codebase
 * has already proved how fragile that is: the previous implementation signed
 * `type: 'pass'` while both verifiers tested `typ`, so a pass sailed through
 * the access-token gate and no genuine pass ever verified at a gate. A
 * different key and algorithm cannot be got wrong by a typo.
 *
 * The second is the door. A scanner at a venue with no usable network has to
 * verify a pass on its own, and it can do that with the public key while the
 * private key never leaves the server. That is only possible with an
 * asymmetric algorithm. ES256 over P-256 keeps the signature to 64 bytes,
 * which matters when the whole token has to fit in a QR code someone scans in
 * a queue.
 */

export const PASS_TYPE = 'pass' as const;

/**
 * What the token carries, and deliberately what it does not.
 *
 * There is no tier here. The tier is read from the database at verification
 * time, so a pass cannot assert its own privilege: a refund, a downgrade or a
 * flag takes effect on the next scan rather than whenever the token happens to
 * expire. A screenshot of someone else's pass is worth exactly what the server
 * says that delegate is worth, which is the point of having a gate.
 */
export interface PassClaims {
  sub: string;
  typ: typeof PASS_TYPE;
  iat: number;
  exp: number;
}

export interface PassVerification {
  valid: boolean;
  name?: string;
  organisation?: string | null;
  tier?: AccessTier;
  flagged?: boolean;
}

/**
 * A day, so a delegate who has been out of signal since yesterday can still
 * show a pass at the door. Short-lived tokens assume a working network, and
 * the summit measured 0.55 Mbps in the hall. Raise it for a multi-day event
 * via PASS_TTL_SEC; the exposure a longer window buys is bounded by the fact
 * that a pass grants nothing on its own - it identifies, the server decides.
 */
const DEFAULT_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class PassService {
  private readonly logger = new Logger(PassService.name);
  /** No defaults on purpose: every key and algorithm is passed per call. */
  private readonly jwt = new JwtService({});

  constructor(
    private readonly config: ConfigService,
    private readonly delegates: DelegatesService,
    private readonly security: SecurityService,
  ) {}

  /**
   * PEM keys arrive from the environment with escaped newlines, the same
   * convention as FIREBASE_PRIVATE_KEY. A PEM whose line breaks are still the
   * two characters backslash-n is not a key, so unescape before use.
   */
  private key(name: 'PASS_PRIVATE_KEY' | 'PASS_PUBLIC_KEY'): string {
    const raw = this.config.get<string>(name);
    if (!raw) {
      throw new ServiceUnavailableException('Passes are not configured');
    }
    return raw.replace(/\\n/g, '\n');
  }

  private get ttlSec(): number {
    return this.config.get<number>('PASS_TTL_SEC') ?? DEFAULT_TTL_SEC;
  }

  /** The public half, for scanners that must verify without reaching us. */
  publicKey(): { publicKey: string; algorithm: 'ES256' } {
    return { publicKey: this.key('PASS_PUBLIC_KEY'), algorithm: 'ES256' };
  }

  async issue(
    delegateId: string,
  ): Promise<{ pass: string; expiresInSec: number }> {
    const delegate = await this.delegates.findById(delegateId);
    if (!delegate) throw new UnauthorizedException();

    const expiresInSec = this.ttlSec;
    const pass = await this.jwt.signAsync(
      { sub: delegate.id, typ: PASS_TYPE },
      {
        privateKey: this.key('PASS_PRIVATE_KEY'),
        algorithm: 'ES256',
        expiresIn: expiresInSec,
      },
    );
    return { pass, expiresInSec };
  }

  /**
   * Answers the gate's question: is this real, and who is it?
   *
   * Never throws for a bad pass. A scanner in a queue needs a verdict it can
   * paint red, not an exception, and the failure is recorded for the security
   * log either way.
   */
  async verify(passToken: string): Promise<PassVerification> {
    try {
      const claims = await this.claimsOf(passToken);

      const delegate = await this.delegates.findById(claims.sub);
      if (!delegate) throw new Error('unknown delegate');

      return {
        valid: true,
        name: delegate.name,
        organisation: delegate.organisation,
        tier: delegate.accessTier,
        flagged: delegate.flagged,
      };
    } catch (e) {
      // A ServiceUnavailable means we cannot verify anything at all, which is
      // an operator error rather than a bad pass. Let it surface as a 503 so
      // the gate is told to stop scanning instead of turning delegates away.
      if (e instanceof ServiceUnavailableException) throw e;

      await this.security.record({
        type: 'pass_verification_failed',
        description: 'Invalid or expired QR pass presented at a gate',
        severity: EventSeverity.WARNING,
      });
      return { valid: false };
    }
  }

  /**
   * Networking scanner: a delegate points their camera at another delegate's
   * My QR and gets that person's directory card. The same signature checks as
   * the gate, but the answer is the public profile rather than a verdict, and
   * a bad code is a plain 400 - a delegate scanning a poster or an old code is
   * not a security event worth logging.
   */
  async resolve(passToken: string): Promise<DelegateDirectoryDto> {
    let claims: PassClaims;
    try {
      claims = await this.claimsOf(passToken);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      throw new BadRequestException(
        'This QR code is not a valid PIC Events pass, or it has expired',
      );
    }
    // Missing or flagged holders are a 404 from the directory lookup.
    return this.delegates.findDirectoryEntry(claims.sub);
  }

  /** Verifies signature, algorithm, expiry and type; throws on any failure. */
  private async claimsOf(passToken: string): Promise<PassClaims> {
    const claims = await this.jwt.verifyAsync<PassClaims>(passToken, {
      publicKey: this.key('PASS_PUBLIC_KEY'),
      // Pinned. Without this an attacker chooses the algorithm, and "none"
      // or an HMAC over the public key both verify against a key they can
      // read from the scanner.
      algorithms: ['ES256'],
    });
    // Belt and braces behind the key separation: nothing else is signed with
    // this key today, and this makes sure nothing else ever passes for a pass.
    if (claims.typ !== PASS_TYPE) throw new Error('not a pass');
    return claims;
  }
}
