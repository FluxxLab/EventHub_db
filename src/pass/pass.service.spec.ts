import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'crypto';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { DelegatesService } from '../delegate/delegates.service';
import { SecurityService } from '../security/security.service';
import { PassService } from './pass.service';

/**
 * Real ECDSA keys, not mocks. The whole point of this service is that a
 * signature is hard to forge, so a test that stubs the signing proves nothing.
 */
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const DELEGATE = {
  id: 'f2a1c0de-0000-4000-8000-000000000001',
  name: 'Amina Bello',
  organisation: 'Policy Innovation Centre',
  accessTier: AccessTier.VIP,
  flagged: false,
};

const DIRECTORY_VIEW = {
  id: DELEGATE.id,
  name: DELEGATE.name,
  organisation: DELEGATE.organisation,
  country: 'Nigeria',
  accessTier: AccessTier.VIP,
  title: null,
  track: null,
  tags: [],
  tracks: [],
  avatarUrl: null,
  pendingReview: false,
};

function build(env: Record<string, unknown> = {}) {
  const delegates = {
    findById: jest.fn().mockResolvedValue(DELEGATE),
    findDirectoryEntry: jest.fn().mockResolvedValue(DIRECTORY_VIEW),
  };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (key: string) =>
      ({
        PASS_PRIVATE_KEY: privateKey,
        PASS_PUBLIC_KEY: publicKey,
        ...env,
      })[key],
  };
  const service = new PassService(
    config as unknown as ConfigService,
    delegates as unknown as DelegatesService,
    security as unknown as SecurityService,
  );
  return { service, delegates, security };
}

describe('PassService (FR-07)', () => {
  it('issues a pass that verifies and resolves the delegate', async () => {
    const { service } = build();

    const { pass, expiresInSec } = await service.issue(DELEGATE.id);
    const result = await service.verify(pass);

    expect(expiresInSec).toBe(24 * 60 * 60);
    expect(result).toEqual({
      valid: true,
      name: 'Amina Bello',
      organisation: 'Policy Innovation Centre',
      tier: AccessTier.VIP,
      flagged: false,
    });
  });

  it('reads the tier from the database, not from the token', async () => {
    // The pass must not be able to assert its own privilege: a delegate
    // downgraded or refunded after their pass was issued presents the same
    // token and the gate must see the new tier.
    const { service, delegates } = build();
    const pass = (await service.issue(DELEGATE.id)).pass;

    delegates.findById.mockResolvedValue({
      ...DELEGATE,
      accessTier: AccessTier.STANDARD,
      flagged: true,
    });

    const result = await service.verify(pass);
    expect(result.tier).toBe(AccessTier.STANDARD);
    expect(result.flagged).toBe(true);
  });

  it('rejects a token signed with the access-token secret', async () => {
    // The regression this module exists for. The previous implementation
    // signed passes with JWT_SECRET and separated them from access tokens by
    // a claim name, which was misspelled, so passes and access tokens were
    // interchangeable. A different key makes that structurally impossible.
    const { service, security } = build();
    const forged = await new JwtService({
      secret: 'the-access-secret',
    }).signAsync({ sub: DELEGATE.id, typ: 'pass' }, { expiresIn: 300 });

    expect(await service.verify(forged)).toEqual({ valid: false });
    expect(security.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pass_verification_failed' }),
    );
  });

  it('rejects a token that claims a different algorithm', async () => {
    // Algorithm confusion: the public key is handed to every scanner, so a
    // token HMAC-signed with it verifies unless the algorithm is pinned.
    const { service } = build();
    const forged = await new JwtService({ secret: publicKey }).signAsync(
      { sub: DELEGATE.id, typ: 'pass' },
      { expiresIn: 300 },
    );

    expect(await service.verify(forged)).toEqual({ valid: false });
  });

  it('rejects a pass whose payload has been swapped for another delegate', async () => {
    // The attack worth testing: keep the real signature, point the pass at
    // somebody else. This is what "they lied about the pass they paid for"
    // would look like on the wire.
    const { service } = build();
    const [header, , signature] = (await service.issue(DELEGATE.id)).pass.split(
      '.',
    );
    const forgedBody = Buffer.from(
      JSON.stringify({
        sub: 'f2a1c0de-0000-4000-8000-00000000dead',
        typ: 'pass',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');

    expect(
      await service.verify(`${header}.${forgedBody}.${signature}`),
    ).toEqual({ valid: false });
  });

  it('rejects a pass whose signature has been tampered with', async () => {
    const { service } = build();
    const { pass } = await service.issue(DELEGATE.id);
    // Flip a character in the middle of the signature. Not the last one: an
    // ES256 signature is 64 bytes carried in 86 base64url characters, so the
    // final character has spare bits that decode to the same bytes either way.
    const [header, body, signature] = pass.split('.');
    const at = Math.floor(signature.length / 2);
    const tampered = `${header}.${body}.${signature.slice(0, at)}${
      signature[at] === 'A' ? 'B' : 'A'
    }${signature.slice(at + 1)}`;

    expect(await service.verify(tampered)).toEqual({ valid: false });
  });

  it('rejects an expired pass', async () => {
    const { service } = build({ PASS_TTL_SEC: -1 });
    const { pass } = await service.issue(DELEGATE.id);

    expect(await service.verify(pass)).toEqual({ valid: false });
  });

  it('rejects a pass for a delegate who no longer exists', async () => {
    const { service, delegates } = build();
    const { pass } = await service.issue(DELEGATE.id);
    delegates.findById.mockResolvedValue(null);

    expect(await service.verify(pass)).toEqual({ valid: false });
  });

  it('honours PASS_TTL_SEC for a multi-day event', async () => {
    const { service } = build({ PASS_TTL_SEC: 7 * 24 * 60 * 60 });
    expect((await service.issue(DELEGATE.id)).expiresInSec).toBe(604800);
  });

  describe('when the keys are not configured', () => {
    it('refuses to issue rather than returning an unsigned pass', async () => {
      const { service } = build({ PASS_PRIVATE_KEY: undefined });
      await expect(service.issue(DELEGATE.id)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('surfaces 503 at a gate instead of failing every delegate', async () => {
      // A gate that cannot verify must be told to stop, not silently turn
      // away everyone who presents a perfectly good pass.
      const { service, security } = build({ PASS_PUBLIC_KEY: undefined });
      await expect(service.verify('anything')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(security.record).not.toHaveBeenCalled();
    });
  });

  it('unescapes newlines in keys read from the environment', async () => {
    // PEM arrives from the environment as one line with literal backslash-n,
    // the same convention as FIREBASE_PRIVATE_KEY.
    const { service } = build({
      PASS_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
      PASS_PUBLIC_KEY: publicKey.replace(/\n/g, '\\n'),
    });

    const { pass } = await service.issue(DELEGATE.id);
    expect((await service.verify(pass)).valid).toBe(true);
  });

  describe('resolve (networking scanner)', () => {
    it("returns the holder's directory card for a genuine pass", async () => {
      const { service, delegates } = build();
      const { pass } = await service.issue(DELEGATE.id);

      expect(await service.resolve(pass)).toEqual(DIRECTORY_VIEW);
      expect(delegates.findDirectoryEntry).toHaveBeenCalledWith(DELEGATE.id);
    });

    it('refuses a forged or expired pass with a 400 and no security event', async () => {
      const { service, security } = build({ PASS_TTL_SEC: -1 });
      const expired = (await service.issue(DELEGATE.id)).pass;
      const forged = await new JwtService({ secret: 'x' }).signAsync(
        { sub: DELEGATE.id, typ: 'pass' },
        { expiresIn: 300 },
      );

      await expect(service.resolve(expired)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.resolve(forged)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.resolve('not-a-jwt')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(security.record).not.toHaveBeenCalled();
    });

    it('passes through the 404 for a flagged or deleted holder', async () => {
      const { service, delegates } = build();
      const { pass } = await service.issue(DELEGATE.id);
      delegates.findDirectoryEntry.mockRejectedValue(
        new NotFoundException('Delegate not found'),
      );

      await expect(service.resolve(pass)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('surfaces 503 when the keys are not configured', async () => {
      const { service } = build({ PASS_PUBLIC_KEY: undefined });
      await expect(service.resolve('anything')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
