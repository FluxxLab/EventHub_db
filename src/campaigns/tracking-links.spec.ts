import type { ConfigService } from '@nestjs/config';
import { renderCampaign } from './campaign-email';
import { TrackingLinks } from './tracking-links';

/**
 * Tracking: the open image and click redirect name one recipient, and a
 * redirect only ever goes where the email linked, so it cannot be turned
 * into an open redirect by editing the address.
 */
const RID = '11111111-1111-4111-8111-111111111111';

function tracking(
  env: Record<string, string> = { PUBLIC_API_URL: 'https://api.pic.org/' },
) {
  const config = {
    get: jest.fn((k: string) => env[k]),
    getOrThrow: jest.fn(() => 'jwt-secret'),
  } as unknown as ConfigService;
  return new TrackingLinks(config);
}

const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

describe('TrackingLinks', () => {
  it('is off without a public API address', () => {
    expect(tracking({}).enabled()).toBe(false);
    expect(tracking().enabled()).toBe(true);
  });

  it('reads back the recipient of an open image, and refuses a forged one', () => {
    const t = tracking();
    const url = t.pixelUrl(RID);
    expect(url).toMatch(/^https:\/\/api\.pic\.org\/email\/o\/.+\.gif$/);
    expect(t.verifyOpen(tokenOf(url))).toBe(RID);
    expect(t.verifyOpen(`${RID}.forged.gif`)).toBeNull();
  });

  it('redirects only to the address the email linked', () => {
    const t = tracking();
    const click = new URL(t.clickUrl(RID, 'https://pic.org/programme?a=1&b=2'));
    const token = click.pathname.split('/').pop()!;
    expect(t.verifyClick(token, click.searchParams.get('u')!)).toBe(RID);
    expect(t.verifyClick(token, 'https://evil.example/phish')).toBeNull();
    expect(t.verifyClick(token, 'javascript:alert(1)')).toBeNull();
    expect(t.verifyClick(token, undefined)).toBeNull();
  });

  it('puts the image and redirects in the email, showing the addresses as written', () => {
    const html = renderCampaign(
      {
        subject: 's',
        body: 'Programme: https://pic.org/p?a=1&b=2.',
        buttonLabel: 'Open',
        buttonUrl: 'https://pic.org/b',
      },
      { email: 'a@x.org', name: 'Ada', code: 'C', tier: 'VIP' },
      'GS-27',
      'https://console/unsubscribe?t=x',
      {
        pixel: 'https://api/o/p.gif',
        link: (u) => `https://api/c/t?u=${encodeURIComponent(u)}`,
      },
    ).html;
    expect(html).toContain(
      `href="https://api/c/t?u=${encodeURIComponent('https://pic.org/p?a=1&b=2')}"`,
    );
    expect(html).toContain('>https://pic.org/p?a=1&amp;b=2</a>');
    expect(html).toContain(
      `href="https://api/c/t?u=${encodeURIComponent('https://pic.org/b')}"`,
    );
    expect(html).toContain('<img src="https://api/o/p.gif"');
    // the unsubscribe link is never tracked
    expect(html).toContain('href="https://console/unsubscribe?t=x"');
  });
});
