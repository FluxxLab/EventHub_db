import { generate } from './delegate-seed.data';
import { DelegateSeedService } from './delegate-seed.service';
import { AccessTier } from '../entities/delegate.entity';

/**
 * Seeded delegates have to pass as real to a reader and stay traceable to
 * the system. These pin down both, and that the trickle stops at its target.
 */
describe('generate', () => {
  const rows = generate(300);

  it('produces the count asked for, every one on a public mail domain', () => {
    expect(rows).toHaveLength(300);
    for (const r of rows) {
      expect(r.email).toMatch(/^[a-z._0-9]+@(gmail|yahoo)\.com$/);
      expect(r.name.split(' ').length).toBeGreaterThanOrEqual(2);
      expect(r.tracks.length).toBeGreaterThanOrEqual(1);
      expect(r.interests.length).toBeGreaterThanOrEqual(2);
      expect(r.interests.length).toBeLessThanOrEqual(5);
    }
  });

  it('never repeats an email', () => {
    expect(new Set(rows.map((r) => r.email)).size).toBe(rows.length);
  });

  it('invents a title for a made-up delegate and none for a real one, but never an organisation', () => {
    // a null title is how a roster-sourced row is told apart from a fully
    // invented one - null, not '', because an unset field should be unset
    const invented = rows.filter((r) => r.title !== null);
    const fromRoster = rows.filter((r) => r.title === null);
    expect(invented.length).toBeGreaterThan(0);
    expect(fromRoster.length).toBeGreaterThan(0);
    // organisation is a specific, checkable claim - never shown, real name
    // or invented one alike
    for (const r of rows) expect(r.organisation).toBeNull();
    // a real registrant's tier is never guessed - VIP gates real access
    for (const r of fromRoster) expect(r.accessTier).toBe(AccessTier.STANDARD);
  });

  it('draws every real registrant before it invents anyone, name intact', () => {
    const names = new Set(rows.map((r) => r.name));
    for (const n of [
      'Maryam Abdallah',
      'Sylvanus Udoenoh',
      'Simi John Dalyop',
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it('sets no country, mostly standard, some press, few VIP', () => {
    const press = rows.filter((r) => r.accessTier === AccessTier.PRESS).length;
    const vip = rows.filter((r) => r.accessTier === AccessTier.VIP).length;
    // like organisation: a real delegate has none, so a seeded one must not
    for (const r of rows) expect(r.country).toBeNull();
    expect(press).toBeGreaterThan(0);
    expect(vip).toBeLessThan(rows.length / 10);
    expect(
      rows.some((r) =>
        /^(Dr|Mrs|Ms|Mr|Hajiya|Alhaji|Engr|Barr|Prof)\./.test(r.name),
      ),
    ).toBe(true);
  });

  it('never redraws a roster name the caller says is already used', () => {
    // simulate two separate process runs: the first takes almost the whole
    // roster, the second must never repeat any of those exact names, even
    // though it has no other memory of the first run at all
    const first = generate(65);
    const usedNames = new Set(first.map((r) => r.name));
    const second = generate(6, usedNames);
    for (const r of second) expect(usedNames.has(r.name)).toBe(false);
  });

  it('falls back to inventing once every roster name is excluded', () => {
    // pretend the entire roster (70 real registrants) is already spoken for
    const wholeRoster = generate(70).map((r) => r.name);
    const rows2 = generate(3, new Set(wholeRoster));
    for (const r of rows2) expect(r.title).not.toBeNull(); // invented, not real
  });
});

describe('DelegateSeedService.tick', () => {
  /** `alreadySeeded` is the delegates the query for existing seeded rows
   *  returns - real name strings, standing in for rows a previous run (or
   *  this process's own earlier ticks) already inserted. */
  const build = (alreadySeeded: string[], target: number, lock = 'OK') => {
    const saved: unknown[] = [];
    const delegates = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue(alreadySeeded.map((name) => ({ name }))),
      }),
      create: jest.fn().mockImplementation((v: unknown) => v),
      save: jest.fn().mockImplementation(async (v: unknown) => {
        saved.push(v);
        return v;
      }),
    };
    const redis = { set: jest.fn().mockResolvedValue(lock) };
    const config = {
      get: jest
        .fn()
        .mockImplementation((k: string) =>
          k === 'SEED_DELEGATES_TARGET' ? String(target) : undefined,
        ),
    };
    const service = new DelegateSeedService(
      delegates as any,
      redis as any,
      config as any,
    );
    return { service, saved, redis };
  };

  it('inserts one delegate when below target, with no password anyone holds', async () => {
    const { service, saved } = build(Array(10).fill('x'), 150);
    await expect(service.tick()).resolves.toBe(true);
    expect(saved).toHaveLength(1);
    expect((saved[0] as { hasChosenPassword: boolean }).hasChosenPassword).toBe(
      false,
    );
    expect((saved[0] as { pendingReview: boolean }).pendingReview).toBe(false);
  });

  it('never repeats a name a previous run already seeded', async () => {
    // a prior run (or an earlier tick) already took the whole real roster
    // except one name; this tick must land on exactly that one
    const roster = generate(70).map((r) => r.name);
    const { service, saved } = build(roster.slice(0, 69), 150);
    await service.tick();
    expect((saved[0] as { name: string }).name).toBe(roster[69]);
  });

  it('inserts nothing once the target is reached', async () => {
    const { service, saved } = build(Array(150).fill('x'), 150);
    await expect(service.tick()).resolves.toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('skips the tick when another instance holds the lock', async () => {
    const { service, saved, redis } = build(
      Array(10).fill('x'),
      150,
      null as unknown as string,
    );
    await expect(service.tick()).resolves.toBe(false);
    expect(saved).toHaveLength(0);
    expect(redis.set).toHaveBeenCalledWith(
      'seed:delegates:tick',
      '1',
      'PX',
      expect.any(Number),
      'NX',
    );
  });

  it('is off when no target is configured', () => {
    const { service } = build([], 0);
    expect(service.target).toBe(0);
    service.onModuleInit();
    expect((service as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('defaults to twenty minutes', () => {
    const { service } = build([], 150);
    expect(service.intervalMs).toBe(20 * 60_000);
  });
});
