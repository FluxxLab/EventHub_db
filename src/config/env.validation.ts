import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Staging = 'staging',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(Environment) NODE_ENV: Environment;
  @IsInt() @Min(1) @Max(65535) PORT: number;

  @IsString() DB_HOST: string;
  @IsInt() @Min(1) @Max(65535) DB_PORT: number;
  @IsString() DB_USER: string;
  @IsString() DB_PASSWORD: string;
  @IsString() DB_NAME: string;
  /** Postgres connections per API instance (default 30). Keep instances x this under max_connections. */
  @IsOptional() @IsInt() @Min(1) @Max(500) DB_POOL_MAX?: number;
  /** Postgres statement_timeout in ms (default 10000). */
  @IsOptional() @IsInt() @Min(100) DB_STATEMENT_TIMEOUT_MS?: number;

  /** Requests per route per minute for a signed-in user (default 120). */
  @IsOptional() @IsInt() @Min(1) THROTTLE_LIMIT?: number;
  /** Requests per route per minute per IP for anonymous callers (default 600; venue NAT). */
  @IsOptional() @IsInt() @Min(1) THROTTLE_ANON_LIMIT?: number;
  /** Proxy hops in front of the API for req.ip (default 1: Caddy). 2 with an ALB before Caddy. */
  @IsOptional() @IsInt() @Min(0) @Max(10) TRUST_PROXY_HOPS?: number;

  @IsString() JWT_SECRET: string;
  @IsInt() JWT_ACCESS_TTL: number;
  @IsInt() JWT_REFRESH_TTL: number;
  @IsString() REDIS_HOST: string;
  /**
   * 'true' puts the participation checklist back in front of the certificate.
   * Absent or anything else means every approved delegate can claim theirs,
   * which is what the organisers wanted once the summit had finished.
   */
  @IsOptional() @IsString() CERTIFICATE_REQUIRE_PARTICIPATION?: string;
  /** HMAC key for ticket QRs scanned at the entrance gate; falls back to JWT_SECRET. */
  @IsOptional() @IsString() TICKET_QR_SECRET?: string;
  @IsOptional() @IsString() SMTP_HOST?: string;
  @IsOptional() @IsInt() SMTP_PORT?: number;
  @IsOptional() @IsString() SMTP_USER?: string;
  @IsOptional() @IsString() SMTP_PASSWORD?: string;
  @IsOptional() @IsString() SMTP_FROM?: string;
  @IsOptional() @IsString() TERMII_API_KEY?: string;
  @IsOptional() @IsString() TERMII_SENDER_ID?: string;
  // WhatsApp Cloud API (Meta). Both set, or announcements skip WhatsApp and log instead.
  @IsOptional() @IsString() WHATSAPP_TOKEN?: string;
  @IsOptional() @IsString() WHATSAPP_PHONE_NUMBER_ID?: string;
  /** The approved template for announcements; its body takes {{1}} title and {{2}} message. */
  @IsOptional() @IsString() WHATSAPP_ANNOUNCEMENT_TEMPLATE?: string;
  @IsOptional() @IsString() WHATSAPP_TEMPLATE_LANGUAGE?: string;

  @IsInt() @Min(1) @Max(65535) REDIS_PORT: number;

  // Uploads (avatars, documents). Optional: without S3_BUCKET the presign
  // routes return 503 and everything else still runs. Credentials are not
  // here on purpose - the SDK reads the EC2 instance role.
  @IsOptional() @IsString() S3_BUCKET?: string;
  @IsOptional() @IsString() S3_REGION?: string;
  // Local development only: an S3-compatible server (RustFS in
  // docker-compose.yml) instead of AWS, e.g. http://localhost:9000. Its keys go
  // in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, which the SDK reads itself.
  // Leave unset in production.
  @IsOptional() @IsString() S3_ENDPOINT?: string;

  // Push. Without FIREBASE_PROJECT_ID the module falls back to LogPushSender,
  // which logs instead of delivering - so push silently does nothing.
  @IsOptional() @IsString() FIREBASE_PROJECT_ID?: string;
  @IsOptional() @IsString() FIREBASE_CLIENT_EMAIL?: string;
  @IsOptional() @IsString() FIREBASE_PRIVATE_KEY?: string;

  // FR-07 QR passes. An ECDSA P-256 keypair of their own, never JWT_SECRET:
  // the public half goes to gate scanners so they can verify without a
  // network, and a pass signed by a different key can never be mistaken for
  // an access token. Without them the pass routes return 503 and the rest of
  // the API is unaffected. Generate with:
  //   node -e "const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256',privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});console.log('PASS_PRIVATE_KEY='+JSON.stringify(k.privateKey));console.log('PASS_PUBLIC_KEY='+JSON.stringify(k.publicKey))"
  @IsOptional() @IsString() PASS_PRIVATE_KEY?: string;
  @IsOptional() @IsString() PASS_PUBLIC_KEY?: string;
  /** Pass lifetime. Defaults to 24h so a delegate out of signal still gets in. */
  @IsOptional() @IsInt() PASS_TTL_SEC?: number;

  // Live room audio (captions capture, venue streams, the app's Listen
  // card). Optional: without all three, token routes answer 503 and nothing
  // else is affected.
  @IsOptional() @IsString() LIVEKIT_URL?: string;
  @IsOptional() @IsString() LIVEKIT_API_KEY?: string;
  @IsOptional() @IsString() LIVEKIT_API_SECRET?: string;

  /**
   * 'true' turns on venue streams (docs/live-audio-ingest.md): rooms captioned
   * from LiveKit Ingress instead of a capture desk. Needs the LIVEKIT_* keys.
   * Anything else leaves /ingest answering 503 and the webhook ignored.
   */
  @IsOptional() @IsString() INGEST_ENABLED?: string;
  /** How often INGEST re-lists streams from LiveKit (default 30000 ms). */
  @IsOptional() @IsInt() @Min(5_000) INGEST_RECONCILE_MS?: number;
  /** How often a venue stream refused a room (a desk holds it) asks again (default 5000 ms). */
  @IsOptional() @IsInt() @Min(1_000) INGEST_RETRY_MS?: number;
  /**
   * Captions only transcribe while a session is live; held rooms are checked
   * this often for one starting or ending (default 2000 ms). Also the delay
   * before a session's first words are captioned, less the pre-roll.
   */
  @IsOptional() @IsInt() @Min(500) CAPTIONS_SYNC_MS?: number;
  /** Venue-stream audio kept from before a session is noticed live (default CAPTIONS_SYNC_MS + 1000). */
  @IsOptional() @IsInt() @Min(1) CAPTIONS_PREROLL_MS?: number;
  /** Below this much free space in tmp, rooms are captioned but not recorded for the archive (default 2000 MB). */
  @IsOptional() @IsInt() @Min(100) CAPTIONS_MIN_FREE_DISK_MB?: number;
  /** Simultaneous Claude translation calls per API replica (captions). Default 4. */
  @IsOptional() @IsInt() @Min(1) TRANSLATION_CONCURRENCY?: number;
  /** Comma-separated Google OAuth client IDs (web, iOS, Android) accepted by POST /auth/google; unset disables Google sign-in. */
  @IsOptional() @IsString() GOOGLE_CLIENT_IDS?: string;

  // Payments. Each provider is used only when its key is set; without it,
  // orders it would take settle through the log provider (no charge), so
  // development runs without keys. Paystack signs webhooks with the secret
  // key itself; Stripe with a separate endpoint secret (whsec_...).
  /** `flutterwave` (default): Flutterwave takes every country. `paystack-stripe`: Paystack for NG/GH/KE/ZA, Stripe for dollars. */
  @IsOptional()
  @IsIn(['flutterwave', 'paystack-stripe'])
  PAYMENT_GATEWAY?: string;
  @IsOptional() @IsString() FLUTTERWAVE_SECRET_KEY?: string;
  /** The "secret hash" set in the Flutterwave dashboard; sent back as `verif-hash` on webhooks. */
  @IsOptional() @IsString() FLUTTERWAVE_WEBHOOK_HASH?: string;
  @IsOptional() @IsString() PAYSTACK_SECRET_KEY?: string;
  @IsOptional() @IsString() STRIPE_SECRET_KEY?: string;
  @IsOptional() @IsString() STRIPE_WEBHOOK_SECRET?: string;
  /** Where hosted checkout returns the delegate; `?orderId=` is appended. Default picevents://payment/return. */
  @IsOptional() @IsString() PAYMENT_CALLBACK_URL?: string;

  // Campaign emails. PUBLIC_CONSOLE_URL is where the unsubscribe page lives
  // (campaigns are refused without it); PUBLIC_API_URL, when set, also turns
  // on the mail app's own Unsubscribe button (RFC 8058 one-click).
  @IsOptional() @IsString() PUBLIC_CONSOLE_URL?: string;
  @IsOptional() @IsString() PUBLIC_API_URL?: string;
  /** Signs unsubscribe links; JWT_SECRET is used when unset. */
  @IsOptional() @IsString() UNSUBSCRIBE_SECRET?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) throw new Error(errors.toString());

  return validated;
}
