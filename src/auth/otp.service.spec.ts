import { BadRequestException, HttpException } from '@nestjs/common';
import { OtpService } from './otp.service';

/**
 * The code is a credential the delegate holds for one thing. These pin down
 * that checking it does not spend it, that only success spends it, and that
 * guessing stays capped.
 */
describe('OtpService', () => {
  const build = (stored: { code: string; channel: 'email' | 'sms' } | null) => {
    const store = new Map<string, string>();
    if (stored) store.set('otp:code:a@b.com', JSON.stringify(stored));
    let attempts = 0;
    const redis = {
      incr: jest
        .fn()
        .mockImplementation(async (k: string) =>
          k.startsWith('otp:attempts:') ? ++attempts : 1,
        ),
      expire: jest.fn(),
      get: jest
        .fn()
        .mockImplementation(async (k: string) => store.get(k) ?? null),
      set: jest.fn().mockImplementation(async (k: string, v: string) => {
        store.set(k, v);
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        for (const k of keys) store.delete(k);
        return keys.length;
      }),
    };
    const email = { send: jest.fn().mockResolvedValue(undefined) };
    const sms = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new OtpService(redis as any, email, sms);
    return { service, redis, store, email };
  };

  it('checking a right code does not spend it', async () => {
    const { service, store } = build({ code: '123456', channel: 'email' });
    await expect(service.assertValid('A@B.com', '123456')).resolves.toBe(
      'email',
    );
    await expect(service.assertValid('a@b.com', ' 123456 ')).resolves.toBe(
      'email',
    );
    expect(store.has('otp:code:a@b.com')).toBe(true);
  });

  it('consume spends it, so the same code is then refused', async () => {
    const { service, store } = build({ code: '123456', channel: 'sms' });
    await service.consume('a@b.com');
    expect(store.has('otp:code:a@b.com')).toBe(false);
    await expect(
      service.assertValid('a@b.com', '123456'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a wrong code and leaves the right one in place for the next try', async () => {
    const { service, store } = build({ code: '123456', channel: 'email' });
    await expect(
      service.assertValid('a@b.com', '654321'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.has('otp:code:a@b.com')).toBe(true);
    await expect(service.assertValid('a@b.com', '123456')).resolves.toBe(
      'email',
    );
  });

  it('caps guesses, then throws the code away', async () => {
    const { service, store } = build({ code: '123456', channel: 'email' });
    for (let i = 0; i < 10; i++) {
      await service.assertValid('a@b.com', '000000').catch(() => undefined);
    }
    await expect(
      service.assertValid('a@b.com', '123456'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(store.has('otp:code:a@b.com')).toBe(false);
  });

  it('a new request replaces the code and resets the guess count', async () => {
    const { service, store, redis, email } = build({
      code: '123456',
      channel: 'email',
    });
    await service.requestOtp('a@b.com', 'email');
    const now = JSON.parse(store.get('otp:code:a@b.com')!) as { code: string };
    expect(now.code).toMatch(/^\d{6}$/);
    expect(now.code).not.toBe('123456');
    expect(redis.del).toHaveBeenCalledWith('otp:attempts:a@b.com');
    expect(email.send).toHaveBeenCalledWith(
      'a@b.com',
      'Your GS-26 verification code',
      expect.stringContaining(now.code),
    );
  });
});
