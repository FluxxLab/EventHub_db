import type { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Signed read URLs are stable for the hour, so phones and CDNs can cache an
 * avatar instead of re-downloading it on every directory page, while every
 * URL minted still has at least the normal lifetime left.
 */
describe('StorageService signed read URLs', () => {
  const env = { ...process.env };
  beforeAll(() => {
    // static test credentials: presigning is local HMAC, nothing is called
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY =
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
  });
  afterAll(() => {
    process.env = env;
  });
  afterEach(() => jest.restoreAllMocks());

  const service = () =>
    new StorageService({
      get: (k: string) =>
        ({ S3_BUCKET: 'gs26-test', S3_REGION: 'eu-west-2' })[k],
    } as unknown as ConfigService);

  const at = (iso: string) =>
    jest.spyOn(Date, 'now').mockReturnValue(new Date(iso).getTime());

  it('yields the same URL for the same key throughout the hour', async () => {
    const s = service();
    at('2026-09-24T10:00:01Z');
    const first = await s.presignRead('delegate-avatars/a');
    at('2026-09-24T10:59:59Z');
    const second = await s.presignRead('delegate-avatars/a');
    expect(second).toBe(first);
    expect(first).toContain('X-Amz-Date=20260924T100000Z');
  });

  it('changes in the next hour, and differs per object', async () => {
    const s = service();
    at('2026-09-24T10:30:00Z');
    const a = await s.presignRead('delegate-avatars/a');
    const b = await s.presignRead('delegate-avatars/b');
    at('2026-09-24T11:00:00Z');
    const next = await s.presignRead('delegate-avatars/a');
    expect(b).not.toBe(a);
    expect(next).not.toBe(a);
    expect(next).toContain('X-Amz-Date=20260924T110000Z');
  });

  it('covers the rest of the hour plus the normal lifetime', async () => {
    const s = service();
    at('2026-09-24T10:59:00Z');
    const url = new URL(await s.presignRead('delegate-avatars/a'));
    // 45 min default + the hour it was bucketed into
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(45 * 60 + 3600));
  });

  it('computes the window from the hour boundary', () => {
    const w = StorageService.stableWindow(
      600,
      new Date('2026-09-24T10:42:17.123Z').getTime(),
    );
    expect(w.signingDate.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(w.expiresIn).toBe(4200);
    // minted at the last second of the hour, it still has >= the lifetime
    const expiresAt = w.signingDate.getTime() + w.expiresIn * 1000;
    expect(
      expiresAt - new Date('2026-09-24T10:59:59Z').getTime(),
    ).toBeGreaterThanOrEqual(600 * 1000);
  });
});

/** Local development against an S3-compatible server (RustFS in docker-compose.yml). */
describe('StorageService with a local S3 endpoint', () => {
  const env = { ...process.env };
  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = 'picdev';
    process.env.AWS_SECRET_ACCESS_KEY = 'picdev-secret';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
  });
  afterAll(() => {
    process.env = env;
  });

  const local = (endpoint: string) =>
    new StorageService({
      get: (k: string) =>
        ({
          S3_BUCKET: 'pic-events-dev',
          S3_REGION: 'us-east-1',
          S3_ENDPOINT: endpoint,
        })[k],
    } as unknown as ConfigService);

  it('signs against the local server, bucket in the path', async () => {
    const url = new URL(
      await local('http://localhost:9000/').presignRead('delegate-avatars/a'),
    );
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/pic-events-dev/delegate-avatars/a');
  });

  it('treats a full URL on the local server as ours (signed) and anything else as external', async () => {
    const s = local('http://localhost:9000');
    const signed = await s.resolveStoredUrl(
      'http://localhost:9000/pic-events-dev/delegate-avatars/b',
    );
    expect(signed).toContain('/pic-events-dev/delegate-avatars/b?');
    expect(signed).toContain('X-Amz-Signature=');
    await expect(
      s.resolveStoredUrl('https://example.org/me.png'),
    ).resolves.toBe('https://example.org/me.png');
  });
});
