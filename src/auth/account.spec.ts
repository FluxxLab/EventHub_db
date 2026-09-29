import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { GoogleIdentity } from './google-id-token.verifier';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(false),
}));

const compare = bcrypt.compare as jest.Mock;

function build(delegateOverrides: Record<string, unknown> = {}) {
  const delegateService = {
    passwordHashFor: jest.fn().mockResolvedValue('stored-hash'),
    updatePassword: jest.fn().mockResolvedValue(undefined),
    findById: jest
      .fn()
      .mockResolvedValue({ id: 'd1', accessTier: AccessTier.STANDARD }),
    findByGoogleSub: jest.fn().mockResolvedValue(null),
    findByEmailForAuth: jest.fn().mockResolvedValue(null),
    linkGoogle: jest.fn().mockResolvedValue(undefined),
    matchRegistration: jest.fn().mockResolvedValue(null),
    claimRegistration: jest.fn().mockResolvedValue(undefined),
    createDelegate: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'new', accessTier: input.accessTier }),
      ),
    claimHolderAccount: jest
      .fn()
      .mockImplementation((id: string, input: Record<string, unknown>) =>
        Promise.resolve({ id, accessTier: input.accessTier }),
      ),
    ...delegateOverrides,
  };
  const refreshTokens = {
    create: jest.fn((v: unknown) => v),
    save: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('token') };
  const config = { getOrThrow: jest.fn().mockReturnValue(60) };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  const identity: GoogleIdentity = {
    sub: 'g-123',
    email: 'grace@example.org',
    name: 'Grace Obi',
  };
  const google = { verify: jest.fn().mockResolvedValue(identity) };
  const service = new AuthService(
    refreshTokens as any,
    jwt as any,
    config as any,
    delegateService as any,
    {} as any,
    {} as any,
    security as any,
    google as any,
  );
  return { service, delegateService, refreshTokens, security, google };
}

const tokens = {
  accessToken: 'token',
  refreshToken: 'token',
  refreshTokenId: expect.any(String),
};

describe('AuthService.changePassword', () => {
  beforeEach(() => compare.mockReset().mockResolvedValue(false));

  it('refuses a wrong current password with a plain message and changes nothing', async () => {
    const { service, delegateService, refreshTokens } = build();
    await expect(
      service.changePassword('d1', 'wrong-one', 'new password', {}),
    ).rejects.toThrow(
      new BadRequestException('Your current password is incorrect'),
    );
    expect(delegateService.updatePassword).not.toHaveBeenCalled();
    expect(refreshTokens.update).not.toHaveBeenCalled();
  });

  it('saves the new hash, signs out every other session, records it and returns a fresh pair', async () => {
    compare.mockResolvedValueOnce(true);
    const { service, delegateService, refreshTokens, security } = build();
    await expect(
      service.changePassword('d1', 'old password', 'new password', {}),
    ).resolves.toEqual(tokens);
    expect(compare).toHaveBeenCalledWith('old password', 'stored-hash');
    expect(delegateService.updatePassword).toHaveBeenCalledWith('d1', 'hashed');
    // every live refresh token of this user, before the new pair is issued
    expect(refreshTokens.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'd1' }),
      { revokedAt: expect.any(Date) },
    );
    const revokeOrder = refreshTokens.update.mock.invocationCallOrder[0];
    const issueOrder = refreshTokens.save.mock.invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(issueOrder);
    expect(security.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'password_changed', actorId: 'd1' }),
    );
  });

  it('forgives a trailing space on the current password, as login does', async () => {
    compare.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { service, delegateService } = build();
    await service.changePassword('d1', 'old password ', 'new password', {});
    expect(delegateService.updatePassword).toHaveBeenCalled();
  });
});

describe('AuthService.googleSignIn', () => {
  it('signs straight in when the Google id is already linked', async () => {
    const { service, delegateService } = build({
      findByGoogleSub: jest
        .fn()
        .mockResolvedValue({ id: 'd9', accessTier: AccessTier.VIP }),
    });
    await expect(
      service.googleSignIn('id-token', undefined, {}),
    ).resolves.toEqual(tokens);
    expect(delegateService.findByEmailForAuth).not.toHaveBeenCalled();
  });

  it('links an existing account by email on first use, no consent needed', async () => {
    const { service, delegateService, security } = build({
      findByEmailForAuth: jest.fn().mockResolvedValue({
        id: 'd1',
        hasChosenPassword: true,
        tags: [],
        googleSub: null,
      }),
    });
    await expect(
      service.googleSignIn('id-token', undefined, {}),
    ).resolves.toEqual(tokens);
    expect(delegateService.linkGoogle).toHaveBeenCalledWith('d1', 'g-123');
    expect(security.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_linked' }),
    );
    expect(delegateService.createDelegate).not.toHaveBeenCalled();
  });

  it('refuses an account already linked to a different Google id', async () => {
    const { service } = build({
      findByEmailForAuth: jest.fn().mockResolvedValue({
        id: 'd1',
        hasChosenPassword: true,
        tags: [],
        googleSub: 'someone-else',
      }),
    });
    await expect(
      service.googleSignIn('id-token', true, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never hands a seeded placeholder to whoever owns that mailbox', async () => {
    const { service, delegateService } = build({
      findByEmailForAuth: jest.fn().mockResolvedValue({
        id: 's1',
        hasChosenPassword: false,
        tags: ['seed'],
        googleSub: null,
      }),
    });
    await expect(
      service.googleSignIn('id-token', true, {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(delegateService.linkGoogle).not.toHaveBeenCalled();
  });

  it('asks for consent before creating an account, with a machine-readable code', async () => {
    const { service, delegateService } = build();
    const err = await service
      .googleSignIn('id-token', undefined, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      message: 'Accept the terms to create your account',
      code: 'consent_required',
    });
    expect(delegateService.createDelegate).not.toHaveBeenCalled();
  });

  it('creates the account with consent, Google name, no chosen password and the list tier', async () => {
    const { service, delegateService } = build({
      matchRegistration: jest.fn().mockResolvedValue({
        id: 'entry1',
        assignedTier: AccessTier.PRESS,
        organisation: 'Daily Trust',
        title: 'Reporter',
      }),
    });
    await expect(service.googleSignIn('id-token', true, {})).resolves.toEqual(
      tokens,
    );
    expect(delegateService.matchRegistration).toHaveBeenCalledWith(
      'grace@example.org',
    );
    expect(delegateService.createDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Grace Obi',
        email: 'grace@example.org',
        accessTier: AccessTier.PRESS,
        organisation: 'Daily Trust',
        title: 'Reporter',
        hasChosenPassword: false,
        googleSub: 'g-123',
        consentAt: expect.any(Date),
        pendingReview: false,
      }),
    );
    expect(delegateService.claimRegistration).toHaveBeenCalledWith(
      'entry1',
      'new',
    );
  });

  it('claims an unclaimed ticket-holder account instead of creating one, with consent', async () => {
    const holder = {
      id: 'holder1',
      name: 'G. Obi',
      hasChosenPassword: false,
      tags: ['ticket-holder'],
      googleSub: null,
      phone: null,
      organisation: null,
      title: null,
    };
    const { service, delegateService } = build({
      findByEmailForAuth: jest.fn().mockResolvedValue(holder),
    });
    await expect(
      service.googleSignIn('id-token', undefined, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(delegateService.claimHolderAccount).not.toHaveBeenCalled();

    await service.googleSignIn('id-token', true, {});
    expect(delegateService.claimHolderAccount).toHaveBeenCalledWith(
      'holder1',
      expect.objectContaining({
        name: 'Grace Obi',
        hasChosenPassword: false,
        googleSub: 'g-123',
        consentAt: expect.any(Date),
      }),
    );
    expect(delegateService.createDelegate).not.toHaveBeenCalled();
  });
});

describe('AuthService.forgotPassword for a Google account', () => {
  it('emails a code to an account created by Google sign-in', async () => {
    const otpService = { requestOtp: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      {
        findByEmailForAuth: jest.fn().mockResolvedValue({
          hasChosenPassword: false,
          tags: [],
          googleSub: 'g-123',
        }),
      } as any,
      otpService as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await service.forgotPassword('grace@example.org');
    expect(otpService.requestOtp).toHaveBeenCalled();
  });
});
