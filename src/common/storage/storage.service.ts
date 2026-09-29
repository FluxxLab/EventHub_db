import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string | undefined;
  /**
   * Read once and shared. Signing against one region while building the public
   * URL for another produces a presigned URL S3 answers with 404 NoSuchBucket,
   * and a stored avatar URL pointing at a host that does not exist - both
   * silent, and neither traceable to a config default.
   */
  private readonly region: string;
  /**
   * Where objects of ours live when written as a full URL, so one can be told
   * apart from a genuinely external URL: AWS's virtual-hosted form, or
   * `<endpoint>/<bucket>/` for a local S3-compatible server.
   */
  private readonly ownPrefix: string | null;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.get<string>('S3_BUCKET');
    this.region = config.get<string>('S3_REGION') ?? 'eu-west-2';
    // Local development can point at an S3-compatible server (RustFS in
    // docker-compose.yml). Those serve buckets by path, not by subdomain.
    const endpoint = config.get<string>('S3_ENDPOINT')?.replace(/\/+$/, '');
    // No credentials here on purpose: the SDK reads the EC2 instance role in
    // production, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY locally.
    this.client = new S3Client(
      endpoint
        ? { region: this.region, endpoint, forcePathStyle: true }
        : { region: this.region },
    );
    this.ownPrefix = !this.bucket
      ? null
      : endpoint
        ? `${endpoint}/${this.bucket}/`
        : `https://${this.bucket}.s3.${this.region}.amazonaws.com/`;
  }

  /**
   * Remove one of our own objects. External URLs and unset values are ignored:
   * there is nothing of ours to delete. A missing object is not an error - S3
   * answers 204 either way, and the profile column is cleared regardless.
   */
  async deleteObject(stored: string | null | undefined): Promise<void> {
    if (!stored || !this.bucket || /^https?:\/\//.test(stored)) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: stored }),
    );
  }

  /**
   * A one-time permission slip for the client to PUT a file directly to S3.
   *
   * With `contentLength` the size and the content type are both part of the
   * signature: S3 refuses (403) a PUT of any other length or type. Without it
   * only the key is bound - the presigner leaves Content-Type unsigned by
   * default, so it is a hint rather than a rule (avatars rely on the app).
   */
  async presignUpload(input: {
    folder: string;
    contentType: string;
    contentLength?: number;
  }) {
    if (!this.bucket)
      throw new ServiceUnavailableException('Uploads are not configured');

    const key = `${input.folder}/${randomUUID()}`;
    const bound = input.contentLength !== undefined;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: input.contentType,
        ...(bound ? { ContentLength: input.contentLength } : {}),
      }),
      {
        expiresIn: 300, // 5 min to start the upload
        ...(bound ? { signableHeaders: new Set(['content-type']) } : {}),
      },
    );
    return { uploadUrl, key };
  }

  /**
   * What storage holds under a key, or null when there is nothing there.
   * Used to check an upload the client says it made before anything points
   * at it.
   */
  async headObject(key: string): Promise<{
    size: number;
    contentType: string | null;
    lastModified: Date | null;
  } | null> {
    if (!this.bucket)
      throw new ServiceUnavailableException('Uploads are not configured');
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
        lastModified: head.LastModified ?? null,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || (error as Error).name === 'NotFound') return null;
      throw error;
    }
  }

  /**
   * Remove every object under a prefix (a delegate's own upload folder).
   * One DeleteObject per key rather than a batch DeleteObjects: the batch
   * call needs a Content-MD5 some S3-compatible servers reject, and these
   * folders are small. Returns how many were removed.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (!this.bucket || !prefix.endsWith('/')) return 0;
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: object.Key }),
        );
        removed += 1;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }

  /**
   * A time-limited URL to read one object.
   *
   * The bucket has Block Public Access on, so there is no public URL to store -
   * a bare S3 URL would 403 on every render. Delegate photographs are not
   * something to leave world-readable at this event regardless of how
   * unguessable the key is: press and advocacy attendees are in this directory.
   *
   * What gets persisted on the delegate is therefore the *key*, and a fresh
   * signed URL is minted whenever the record is read. Signing is local HMAC -
   * no network call - so doing it per row in a directory listing is cheap.
   *
   * The 45 minute default is bounded by the credentials, not by choice. These
   * URLs are signed with the EC2 instance role's *temporary* credentials, and
   * S3 rejects a presigned URL once the credentials behind it expire - so any
   * expiry beyond the role's session duration (currently 1 hour on gs26-ssm) is
   * a promise the URL cannot keep. Raising it means raising the role's session
   * duration first, or signing with a long-lived principal instead.
   *
   * Stable within the hour. The signature is computed over the signing date,
   * so signing with "now" gave every render a new URL: phones re-downloaded
   * the same avatar on every directory page and CDN/ETag caching never
   * matched. The signing date is therefore rounded down to the hour and the
   * lifetime stretched by one hour (`expiresIn + 3600`), so:
   *  - the same key (with the same credentials) yields the same URL for the
   *    whole hour, and
   *  - a URL minted at any point in the hour still has at least `expiresIn`
   *    seconds left (it expires at hourStart + 1h + expiresIn).
   * What this costs: a URL can now stay valid for up to one hour longer
   * than `expiresIn` after it is handed out (at most 1h45m by default, down
   * from 45m). Everything else holds - the bucket stays private, the URL
   * still names exactly one object and one verb (GET), and S3 still refuses
   * it once the signing credentials expire, whichever comes first. A
   * credential rotation mid-hour changes the security token in the URL, so
   * clients simply see one new URL at rotation.
   */
  presignRead(key: string, expiresIn = 45 * 60): Promise<string> {
    if (!this.bucket)
      throw new ServiceUnavailableException('Uploads are not configured');
    const { signingDate, expiresIn: stretched } =
      StorageService.stableWindow(expiresIn);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: stretched, signingDate },
    );
  }

  /**
   * The hour-bucketed signing window for `presignRead`: the signing date
   * rounded down to the hour, and a lifetime covering the rest of that hour
   * plus `expiresIn`. Constant for every call in the same UTC hour.
   */
  static stableWindow(
    expiresIn: number,
    now: number = Date.now(),
  ): { signingDate: Date; expiresIn: number } {
    const hourMs = 60 * 60 * 1000;
    return {
      signingDate: new Date(Math.floor(now / hourMs) * hourMs),
      expiresIn: expiresIn + hourMs / 1000,
    };
  }

  /**
   * Resolves whatever is stored on a record into something the app can render.
   *
   * Tolerates both shapes: a key (what is written from now on) and a full URL
   * (anything stored earlier, or an external avatar), so this can ship without
   * a data migration. Returns null rather than throwing - a broken avatar must
   * never take down a profile or a directory page.
   */
  /** Delegate photos - see resolveStoredUrl, which this is a named case of. */
  resolveAvatar(stored: string | null | undefined): Promise<string | null> {
    return this.resolveStoredUrl(stored);
  }

  /**
   * Turn whatever is in the database into something a client can fetch: our
   * own keys get signed, external URLs pass through.
   */
  async resolveStoredUrl(
    stored: string | null | undefined,
  ): Promise<string | null> {
    if (!stored) return null;

    /**
     * A URL pointing at our own bucket has to be turned back into a key and
     * signed, not passed through. Older clients saved the public URL this
     * service used to hand out, and with Block Public Access on that URL 403s
     * forever - so trusting "it starts with https" would leave every avatar
     * uploaded before the switch permanently broken, with no error anywhere.
     */
    const ownPrefix = this.ownPrefix;
    const key =
      ownPrefix && stored.startsWith(ownPrefix)
        ? stored.slice(ownPrefix.length)
        : stored.startsWith('http://') || stored.startsWith('https://')
          ? null // genuinely external - leave it alone
          : stored;

    if (key === null) return stored;
    if (!this.bucket) return null;
    try {
      return await this.presignRead(key);
    } catch {
      return null;
    }
  }
}
