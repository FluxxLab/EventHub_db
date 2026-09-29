import type { ConfigService } from '@nestjs/config';
import { UnsubscribeLinks } from './unsubscribe-links';

/**
 * Unsubscribe links: a token names one address and cannot be edited into
 * another; the links point where the server is told, and the one-click
 * headers only exist when there is a public API address to post to.
 */
function links(env: Record<string, string> = {}) {
  const config = {
    get: jest.fn((k: string) => env[k]),
    getOrThrow: jest.fn(() => 'jwt-secret'),
  } as unknown as ConfigService;
  return new UnsubscribeLinks(config);
}

describe('UnsubscribeLinks', () => {
  it('signs an address and reads it back, case-folded', () => {
    const l = links();
    expect(l.verify(l.token(' Ada@Example.org '))).toBe('ada@example.org');
  });

  it('refuses a token edited to another address, or mangled', () => {
    const l = links();
    const [, sig] = l.token('ada@example.org').split('.');
    const forged = `${Buffer.from('bola@example.org').toString('base64url')}.${sig}`;
    expect(l.verify(forged)).toBeNull();
    expect(l.verify('nonsense')).toBeNull();
    expect(l.verify(undefined)).toBeNull();
    expect(
      links({ UNSUBSCRIBE_SECRET: 'other' }).verify(l.token('ada@example.org')),
    ).toBeNull();
  });

  it('links to the console page, and adds one-click headers only with an API address', () => {
    const plain = links({ PUBLIC_CONSOLE_URL: 'https://console.pic.org/' });
    expect(plain.pageUrl('ada@example.org')).toMatch(
      /^https:\/\/console\.pic\.org\/unsubscribe\?t=/,
    );
    expect(plain.headers('ada@example.org')).toEqual({});
    const both = links({
      PUBLIC_CONSOLE_URL: 'https://c',
      PUBLIC_API_URL: 'https://api.pic.org',
    });
    expect(both.headers('ada@example.org')).toEqual({
      'List-Unsubscribe': expect.stringMatching(
        /^<https:\/\/api\.pic\.org\/email\/unsubscribe\/one-click\?t=.+>$/,
      ),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(links().consoleUrl()).toBeNull();
  });
});
