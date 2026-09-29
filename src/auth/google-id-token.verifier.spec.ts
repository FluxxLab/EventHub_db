import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GoogleIdTokenVerifier } from './google-id-token.verifier';

/**
 * Google's tokeninfo checks the signature; everything after that is ours:
 * our client id, Google as issuer, a verified email, not expired.
 */
describe('GoogleIdTokenVerifier', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const build = (clientIds: string | undefined) =>
    new GoogleIdTokenVerifier({
      get: jest.fn().mockReturnValue(clientIds),
    } as any);

  const respond = (status: number, body: Record<string, unknown>) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
    global.fetch = fetchMock;
    return fetchMock;
  };

  const good = () => ({
    aud: 'ios-client.apps.googleusercontent.com',
    iss: 'https://accounts.google.com',
    sub: '1098',
    email: ' Grace@Example.org ',
    email_verified: 'true',
    exp: String(Math.floor(Date.now() / 1000) + 600),
    name: 'Grace Obi',
  });

  it('503s when GOOGLE_CLIENT_IDS is unset, without calling Google', async () => {
    const fetchMock = respond(200, good());
    await expect(build(undefined).verify('t')).rejects.toThrow(
      new ServiceUnavailableException('Google sign-in is not configured'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a token for any listed client id and normalises the email', async () => {
    const fetchMock = respond(200, good());
    await expect(
      build(
        'web-client.apps.googleusercontent.com, ios-client.apps.googleusercontent.com',
      ).verify('abc.def'),
    ).resolves.toEqual({
      sub: '1098',
      email: 'grace@example.org',
      name: 'Grace Obi',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/tokeninfo?id_token=abc.def',
    );
  });

  it.each([
    ['issued to another app', { aud: 'someone-else' }],
    ['not issued by Google', { iss: 'https://evil.example' }],
    ['expired', { exp: String(Math.floor(Date.now() / 1000) - 5) }],
    ['missing a subject', { sub: undefined }],
  ])('401s a token %s', async (_label, patch) => {
    respond(200, { ...good(), ...patch });
    await expect(
      build('ios-client.apps.googleusercontent.com').verify('t'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s an unverified email', async () => {
    respond(200, { ...good(), email_verified: 'false' });
    await expect(
      build('ios-client.apps.googleusercontent.com').verify('t'),
    ).rejects.toThrow('Your Google account’s email address is not verified');
  });

  it('401s when Google rejects the token', async () => {
    respond(400, { error: 'invalid_token' });
    await expect(
      build('ios-client.apps.googleusercontent.com').verify('t'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('503s when Google cannot be reached', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      build('ios-client.apps.googleusercontent.com').verify('t'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
