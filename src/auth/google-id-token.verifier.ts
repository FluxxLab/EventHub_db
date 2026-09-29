import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** What sign-in needs from a verified Google ID token. */
export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
  /** Lower-cased and trimmed. Google has confirmed the account owns it. */
  email: string;
  /** The display name on the Google account, when it has one. */
  name: string | null;
}

/** The fields of Google's tokeninfo response this verifier reads. */
interface TokenInfo {
  aud?: string;
  iss?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  exp?: string | number;
  name?: string;
}

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Checks a Google ID token by asking Google's tokeninfo endpoint, which
 * validates the signature for us - no new dependency and no key rotation to
 * track. It then checks what tokeninfo does not: that the token was issued
 * to one of our client ids, by Google, for a verified email, and has not
 * expired.
 *
 * GOOGLE_CLIENT_IDS is a comma list because each platform (iOS, Android,
 * web) has its own OAuth client id. Unset, Google sign-in is off (503).
 */
@Injectable()
export class GoogleIdTokenVerifier {
  private readonly logger = new Logger(GoogleIdTokenVerifier.name);

  constructor(private readonly config: ConfigService) {}

  private clientIds(): string[] {
    return (this.config.get<string>('GOOGLE_CLIENT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const clientIds = this.clientIds();
    if (clientIds.length === 0) {
      throw new ServiceUnavailableException('Google sign-in is not configured');
    }

    let info: TokenInfo;
    try {
      const res = await fetch(
        `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`,
      );
      // Google answers 400 for a token that is malformed, forged or expired
      if (!res.ok) throw new UnauthorizedException(invalid());
      info = (await res.json()) as TokenInfo;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.error('Google tokeninfo request failed', e as Error);
      throw new ServiceUnavailableException(
        'Google sign-in is unavailable right now; try again shortly',
      );
    }

    if (!info.aud || !clientIds.includes(info.aud)) {
      throw new UnauthorizedException(invalid());
    }
    if (!info.iss || !ISSUERS.has(info.iss)) {
      throw new UnauthorizedException(invalid());
    }
    if (!info.sub || !info.email) {
      throw new UnauthorizedException(invalid());
    }
    // tokeninfo sends it as the string 'true'
    if (String(info.email_verified) !== 'true') {
      throw new UnauthorizedException(
        'Your Google account’s email address is not verified',
      );
    }
    const exp = Number(info.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
      throw new UnauthorizedException(invalid());
    }

    return {
      sub: info.sub,
      email: info.email.trim().toLowerCase(),
      name: info.name?.trim() || null,
    };
  }
}

function invalid(): string {
  return 'Google sign-in failed; please try again';
}
