import { NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AccessTier } from '../delegate/entities/delegate.entity';

// registration hashes the password at cost 12, which is a quarter of a
// second the copy rule under test does not need
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(false),
}));

/**
 * The prefill route is public and keyed by a printed code, so its one job
 * beyond returning the entry is to say the same thing for a code that never
 * existed and one that has been claimed.
 */
describe('AuthService.registrationPrefill', () => {
  const build = (entry: Record<string, unknown> | null) => {
    const delegateService = {
      matchRegistration: jest.fn().mockResolvedValue(entry),
    };
    const service = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      delegateService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, delegateService };
  };

  it('returns what the organiser put on the list for an unclaimed code', async () => {
    const { service, delegateService } = build({
      email: 'ada@example.com',
      name: 'Ada Obi',
      organisation: 'Policy Innovation Centre',
      title: null,
    });
    await expect(service.registrationPrefill(' A1B2C3D4 ')).resolves.toEqual({
      email: 'ada@example.com',
      name: 'Ada Obi',
      organisation: 'Policy Innovation Centre',
      title: null,
    });
    // trimmed, and looked up by code only - the email is not known yet
    expect(delegateService.matchRegistration).toHaveBeenCalledWith(
      '',
      'A1B2C3D4',
    );
  });

  it('404s with one message whether the code is unknown or already used', async () => {
    const { service } = build(null);
    await expect(service.registrationPrefill('NOPE')).rejects.toThrow(
      new NotFoundException(
        'That code has already been used or does not exist',
      ),
    );
  });

  it('404s for a blank code without touching the database', async () => {
    const { service, delegateService } = build(null);
    await expect(service.registrationPrefill('   ')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(delegateService.matchRegistration).not.toHaveBeenCalled();
  });
});

/**
 * Registration copies organisation and title from the matched list entry
 * when the body leaves them out. What the invitee typed always wins.
 */
describe('AuthService.registration profile copy', () => {
  const entry = {
    id: 'entry1',
    assignedTier: AccessTier.VIP,
    organisation: 'Policy Innovation Centre',
    title: 'Programme Officer',
  };

  const build = () => {
    const delegateService = {
      findByEmailForAuth: jest.fn().mockResolvedValue(null),
      matchRegistration: jest.fn().mockResolvedValue(entry),
      createDelegate: jest
        .fn()
        .mockImplementation((input: Record<string, unknown>) =>
          Promise.resolve({ id: 'd1', accessTier: input.accessTier }),
        ),
      claimRegistration: jest.fn().mockResolvedValue(undefined),
    };
    const otpService = {
      assertValid: jest.fn().mockResolvedValue('email'),
      consume: jest.fn().mockResolvedValue(undefined),
    };
    const refreshTokens = {
      create: jest.fn().mockImplementation((v: unknown) => v),
      save: jest.fn().mockResolvedValue({}),
    };
    const jwt = { signAsync: jest.fn().mockResolvedValue('token') };
    const config = { getOrThrow: jest.fn().mockReturnValue(60) };
    const security = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      refreshTokens as any,
      jwt as any,
      config as any,
      delegateService as any,
      otpService as any,
      {} as any,
      security as any,
      {} as any,
    );
    return { service, delegateService };
  };

  const dto = {
    email: 'Ada@Example.com',
    password: 'correct horse',
    name: 'Ada Obi',
    inviteCode: 'A1B2C3D4',
    otp: '123456',
    consent: true,
  };

  it('fills organisation and title from the entry when the body has neither', async () => {
    const { service, delegateService } = build();
    await service.registration(dto, {});
    expect(delegateService.createDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ada@example.com',
        accessTier: AccessTier.VIP,
        organisation: 'Policy Innovation Centre',
        title: 'Programme Officer',
      }),
    );
    expect(delegateService.claimRegistration).toHaveBeenCalledWith(
      'entry1',
      'd1',
    );
  });

  it('keeps what the invitee typed over what the list says', async () => {
    const { service, delegateService } = build();
    await service.registration(
      { ...dto, organisation: '  Blackwater Global ', title: 'CTO' },
      {},
    );
    expect(delegateService.createDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        organisation: 'Blackwater Global',
        title: 'CTO',
      }),
    );
  });

  it('stores null when neither side knows', async () => {
    const { service, delegateService } = build();
    delegateService.matchRegistration.mockResolvedValue({
      ...entry,
      organisation: null,
      title: null,
    });
    await service.registration({ ...dto, title: '   ' }, {});
    expect(delegateService.createDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ organisation: null, title: null }),
    );
  });
});

/**
 * forgotPassword is anti-enumeration by design: silent for an unknown email,
 * silent for a placeholder account too. The second case is new - a
 * placeholder's email is a guess at a public mailbox that may belong to a
 * real stranger, and a reset code must never reach it. That has to hold for
 * a row seeded under either marker: `hasChosenPassword` false, or - for a
 * row older than that column - the legacy `seed` tag.
 */
describe('AuthService.forgotPassword', () => {
  const build = (
    delegate: { hasChosenPassword: boolean; tags?: string[] } | null,
  ) => {
    const delegateService = {
      findByEmailForAuth: jest.fn().mockResolvedValue(delegate),
    };
    const otpService = { requestOtp: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      delegateService as any,
      otpService as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, otpService };
  };

  it('emails a code when the account set its own password', async () => {
    const { service, otpService } = build({ hasChosenPassword: true });
    await service.forgotPassword('real@example.com');
    expect(otpService.requestOtp).toHaveBeenCalledWith(
      'real@example.com',
      'email',
      undefined,
      'password reset',
    );
  });

  it('stays silent for a placeholder account', async () => {
    const { service, otpService } = build({ hasChosenPassword: false });
    await service.forgotPassword('placeholder@gmail.com');
    expect(otpService.requestOtp).not.toHaveBeenCalled();
  });

  it('stays silent for a row seeded before the column existed, tag only', async () => {
    const { service, otpService } = build({
      hasChosenPassword: true, // the column's default, since nothing back-fills it
      tags: ['seed'],
    });
    await service.forgotPassword('old-placeholder@gmail.com');
    expect(otpService.requestOtp).not.toHaveBeenCalled();
  });

  it('stays silent when no account matches, same as an unknown email', async () => {
    const { service, otpService } = build(null);
    await service.forgotPassword('nobody@example.com');
    expect(otpService.requestOtp).not.toHaveBeenCalled();
  });
});

/**
 * Someone else paid for this person's ticket, so an account was created for
 * them at settlement with a password nobody holds. Signing up with that email
 * (the code proves the inbox) takes the account over with its tickets; any
 * other existing account still refuses.
 */
describe('AuthService.registration claims a ticket-holder account', () => {
  const build = (existing: Record<string, unknown> | null) => {
    const delegateService = {
      findByEmailForAuth: jest.fn().mockResolvedValue(existing),
      matchRegistration: jest.fn().mockResolvedValue(null),
      createDelegate: jest
        .fn()
        .mockResolvedValue({ id: 'new', accessTier: AccessTier.STANDARD }),
      claimHolderAccount: jest
        .fn()
        .mockImplementation((id: string, input: Record<string, unknown>) =>
          Promise.resolve({ id, accessTier: input.accessTier }),
        ),
      claimRegistration: jest.fn().mockResolvedValue(undefined),
    };
    const otpService = {
      assertValid: jest.fn().mockResolvedValue('email'),
      consume: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      {
        create: jest.fn((v: unknown) => v),
        save: jest.fn().mockResolvedValue({}),
      } as any,
      { signAsync: jest.fn().mockResolvedValue('token') } as any,
      { getOrThrow: jest.fn().mockReturnValue(60) } as any,
      delegateService as any,
      otpService as any,
      {} as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );
    return { service, delegateService, otpService };
  };
  const dto = {
    email: 'grace@example.org',
    password: 'correct horse',
    name: 'Grace Obi',
    otp: '123456',
    consent: true,
  };

  it('takes over the unclaimed account instead of 409ing, with consent recorded', async () => {
    const { service, delegateService, otpService } = build({
      id: 'holder1',
      hasChosenPassword: false,
      tags: ['ticket-holder'],
    });
    await service.registration(dto, {});
    expect(delegateService.createDelegate).not.toHaveBeenCalled();
    expect(delegateService.claimHolderAccount).toHaveBeenCalledWith(
      'holder1',
      expect.objectContaining({
        name: 'Grace Obi',
        passwordHash: 'hashed',
        consentAt: expect.any(Date),
      }),
    );
    expect(otpService.consume).toHaveBeenCalledWith('grace@example.org');
  });

  it('refuses to hand the account over on an SMS code: only the inbox proves the ticket is theirs', async () => {
    const { service, delegateService, otpService } = build({
      id: 'holder1',
      hasChosenPassword: false,
      tags: ['ticket-holder'],
    });
    otpService.assertValid.mockResolvedValue('sms');
    await expect(service.registration(dto, {})).rejects.toThrow(
      'please verify using the email code option',
    );
    expect(delegateService.claimHolderAccount).not.toHaveBeenCalled();
    expect(otpService.consume).not.toHaveBeenCalled();
  });

  it('still refuses an account someone already chose a password for', async () => {
    const { service, delegateService } = build({
      id: 'd1',
      hasChosenPassword: true,
      tags: [],
    });
    await expect(service.registration(dto, {})).rejects.toThrow(
      'An account with this email already exists',
    );
    expect(delegateService.claimHolderAccount).not.toHaveBeenCalled();
  });

  it('never hands over a seeded placeholder, only ticket-holder accounts', async () => {
    const { service } = build({
      id: 's1',
      hasChosenPassword: false,
      tags: ['seed'],
    });
    await expect(service.registration(dto, {})).rejects.toThrow(
      'An account with this email already exists',
    );
  });
});
