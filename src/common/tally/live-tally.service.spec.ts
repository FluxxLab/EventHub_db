import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { FakeRedis } from './fake-redis.testing';
import { LiveTallyService, TALLY_EMIT_WINDOW_MS } from './live-tally.service';

function build() {
  const redis = new FakeRedis();
  const service = new LiveTallyService(redis as unknown as Redis);
  return { redis, service };
}

describe('LiveTallyService counts', () => {
  it('seeds a missing hash from the loader once, then counts in Redis', async () => {
    const { service } = build();
    const load = jest.fn().mockResolvedValue({ a: 3, b: 1 });

    await service.ensure('k', load);
    await service.apply('k', { a: 1 });
    await service.ensure('k', load);
    await service.apply('k', { b: 1, a: -1 });

    expect(load).toHaveBeenCalledTimes(1);
    expect(await service.read('k')).toEqual({ a: 3, b: 2 });
  });

  it('adds nothing on a lost seeding race, so counts are not doubled', async () => {
    const { service } = build();
    let release: (counts: Record<string, number>) => void = () => undefined;
    const first = service.ensure(
      'k',
      () => new Promise((resolve) => (release = resolve)),
    );
    await service.ensure('k', () => Promise.resolve({ a: 2 }));
    release({ a: 2 });
    await first;

    expect(await service.read('k')).toEqual({ a: 2 });
  });

  it('treats increments without the seed marker as unseeded', async () => {
    const { service } = build();
    await service.apply('k', { a: 1 }); // e.g. the key expired between seed and vote
    const load = jest.fn().mockResolvedValue({ a: 5 });

    await service.ensure('k', load);

    expect(load).toHaveBeenCalled();
    expect((await service.read('k')).a).toBe(6);
  });

  it('reset replaces whatever drifted with the authoritative counts', async () => {
    const { service } = build();
    await service.ensure('k', () => Promise.resolve({ a: 9, stray: 2 }));

    await service.reset('k', { a: 4, b: 0 });

    expect(await service.read('k')).toEqual({ a: 4 });
    const load = jest.fn();
    await service.ensure('k', load);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('LiveTallyService.coalesce', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('turns a burst of votes into one emit per window', async () => {
    const { service } = build();
    const emit = jest.fn();

    const scheduled = await Promise.all(
      Array.from({ length: 500 }, () => service.coalesce('poll:p1', emit)),
    );
    expect(scheduled.filter(Boolean)).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits once per window for a steady stream, never more', async () => {
    const { service } = build();
    const emit = jest.fn();

    // a vote every 50 ms for 5 s
    for (let t = 0; t < 5000; t += 50) {
      await service.coalesce('topic:t1', emit);
      await jest.advanceTimersByTimeAsync(50);
    }
    await jest.advanceTimersByTimeAsync(2000);

    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('coalesces across instances sharing one Redis', async () => {
    const redis = new FakeRedis();
    const a = new LiveTallyService(redis as unknown as Redis);
    const b = new LiveTallyService(redis as unknown as Redis);
    const emitA = jest.fn();
    const emitB = jest.fn();

    await a.coalesce('trivia:q1', emitA);
    await b.coalesce('trivia:q1', emitB);
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(emitA.mock.calls.length + emitB.mock.calls.length).toBe(1);
  });

  it('keeps items independent', async () => {
    const { service } = build();
    const emit = jest.fn();
    await service.coalesce('poll:p1', emit);
    await service.coalesce('poll:p2', emit);
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('reads the counts at emit time, so the emit carries every vote of the window', async () => {
    const { service } = build();
    await service.ensure('k', () => Promise.resolve({}));
    const seen: Array<Record<string, number>> = [];
    const emit = async () => {
      seen.push(await service.read('k'));
    };

    for (let i = 0; i < 10; i++) {
      await service.apply('k', { a: 1 });
      await service.coalesce('k', emit);
    }
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(seen).toEqual([{ a: 10 }]);
  });

  it('logs rather than throws when an emit fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = build();
    await service.coalesce('x', () => Promise.reject(new Error('boom')));
    await expect(
      jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100),
    ).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });
});

describe('LiveTallyService dirty sets', () => {
  it('drains each marked member once', async () => {
    const { service } = build();
    await service.markDirty('d', 'q1');
    await service.markDirty('d', 'q2');
    await service.markDirty('d', 'q1');

    expect((await service.drainDirty('d')).sort()).toEqual(['q1', 'q2']);
    expect(await service.drainDirty('d')).toEqual([]);
  });
});
