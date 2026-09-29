import {
  CaptureLock,
  InterimThrottle,
  KeyedSerializer,
  REFRESH_LOCK_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  SeqClock,
  Semaphore,
  TranslationScheduler,
  type LockRedis,
} from './caption-pipeline';

/** Enough of Redis for the lock: SET NX PX, GET, PTTL and the two scripts. */
class FakeRedis implements LockRedis {
  private readonly store = new Map<
    string,
    { value: string; expires: number }
  >();
  now = 0;

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expires <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: string, ...opts: ['PX', number, 'NX']) {
    if (this.live(key)) return Promise.resolve(null);
    this.store.set(key, { value, expires: this.now + opts[1] });
    return Promise.resolve('OK' as const);
  }

  get(key: string) {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  pttl(key: string) {
    const entry = this.live(key);
    return Promise.resolve(entry ? entry.expires - this.now : -2);
  }

  eval(script: string, _n: number, ...args: (string | number)[]) {
    const [key, owner, ttl] = args as [string, string, number];
    const entry = this.live(key);
    if (!entry || entry.value !== owner) return Promise.resolve(0);
    if (script === REFRESH_LOCK_SCRIPT) entry.expires = this.now + Number(ttl);
    else if (script === RELEASE_LOCK_SCRIPT) this.store.delete(key);
    return Promise.resolve(1);
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('CaptureLock', () => {
  it('lets one instance capture a room and refuses the other', async () => {
    const redis = new FakeRedis();
    const a = new CaptureLock(redis, 'a', 30_000);
    const b = new CaptureLock(redis, 'b', 30_000);

    await expect(a.acquire('Main Hall')).resolves.toEqual({ ok: true });
    redis.now = 10_000;
    await expect(b.acquire('Main Hall')).resolves.toEqual({
      ok: false,
      holder: 'a',
      retryAfterMs: 20_000,
    });
  });

  it('matches rooms loosely, like the live-session lookup', async () => {
    const redis = new FakeRedis();
    await new CaptureLock(redis, 'a').acquire('Main Hall');
    const other = await new CaptureLock(redis, 'b').acquire('  main hall ');
    expect(other.ok).toBe(false);
  });

  it('is re-entrant for the holder (a desk reconnecting to the same instance)', async () => {
    const redis = new FakeRedis();
    const a = new CaptureLock(redis, 'a', 30_000);
    await a.acquire('Hall B');
    redis.now = 25_000;
    await expect(a.acquire('Hall B')).resolves.toEqual({ ok: true });
    // and that re-acquire extended the TTL
    redis.now = 50_000;
    await expect(
      new CaptureLock(redis, 'b').acquire('Hall B'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('stays held while audio refreshes it', async () => {
    const redis = new FakeRedis();
    const a = new CaptureLock(redis, 'a', 30_000);
    const b = new CaptureLock(redis, 'b', 30_000);
    await a.acquire('Hall B');
    for (let t = 5_000; t <= 120_000; t += 5_000) {
      redis.now = t;
      await expect(a.refresh('Hall B')).resolves.toBe(true);
    }
    await expect(b.acquire('Hall B')).resolves.toMatchObject({ ok: false });
  });

  it('is taken over once the holder stops refreshing and the TTL lapses', async () => {
    const redis = new FakeRedis();
    const a = new CaptureLock(redis, 'a', 30_000);
    const b = new CaptureLock(redis, 'b', 30_000);
    await a.acquire('Hall B');
    redis.now = 30_001; // instance a died
    await expect(b.acquire('Hall B')).resolves.toEqual({ ok: true });
    // and a, coming back, has lost it: refresh reports so and cannot steal it
    await expect(a.refresh('Hall B')).resolves.toBe(false);
    await expect(a.acquire('Hall B')).resolves.toMatchObject({
      ok: false,
      holder: 'b',
    });
  });

  it('is handed over immediately on release, and never releases another holder', async () => {
    const redis = new FakeRedis();
    const a = new CaptureLock(redis, 'a');
    const b = new CaptureLock(redis, 'b');
    await a.acquire('Hall C');
    await b.release('Hall C'); // not b's to release
    await expect(b.acquire('Hall C')).resolves.toMatchObject({ ok: false });
    await a.release('Hall C');
    await expect(b.acquire('Hall C')).resolves.toEqual({ ok: true });
  });
});

describe('KeyedSerializer', () => {
  it('runs one room strictly in order even when earlier work is slower', async () => {
    jest.useFakeTimers();
    try {
      const serial = new KeyedSerializer();
      const order: string[] = [];
      const slow = (label: string, ms: number) => () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push(label);
            resolve();
          }, ms),
        );

      // An interim whose handling is slow must still finish before its final.
      void serial.run('hall', slow('interim', 300));
      const last = serial.run('hall', slow('final', 10));
      await jest.advanceTimersByTimeAsync(400);
      await last;
      expect(order).toEqual(['interim', 'final']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not hold one room behind another', async () => {
    const serial = new KeyedSerializer();
    const order: string[] = [];
    let release!: () => void;
    void serial.run(
      'a',
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await serial.run('b', () => {
      order.push('b');
      return Promise.resolve();
    });
    expect(order).toEqual(['b']);
    release();
  });

  it('keeps going after a task fails, and reports the failure', async () => {
    const serial = new KeyedSerializer();
    const errors: unknown[] = [];
    const ran: number[] = [];
    void serial.run(
      'a',
      () => Promise.reject(new Error('boom')),
      (e) => errors.push(e),
    );
    await serial.run('a', () => {
      ran.push(2);
      return Promise.resolve();
    });
    expect(errors).toHaveLength(1);
    expect(ran).toEqual([2]);
    expect(serial.size).toBe(0);
  });
});

describe('Semaphore', () => {
  it('never exceeds its size', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const tasks = Array.from({ length: 5 }, () =>
      semaphore.use(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
      }),
    );
    await flush();
    expect(gates).toHaveLength(2);
    while (gates.length) {
      gates.shift()!();
      await flush();
    }
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(semaphore.inUse).toBe(0);
  });
});

describe('TranslationScheduler', () => {
  /** A translation call that finishes when the test says so. */
  function controllable() {
    const pending = new Map<string, () => void>();
    const call = (label: string) => () =>
      new Promise<string>((resolve) =>
        pending.set(label, () => resolve(label)),
      );
    return { pending, call };
  }

  it('caps calls in flight across rooms', async () => {
    const scheduler = new TranslationScheduler(2);
    const { pending, call } = controllable();
    const done: string[] = [];
    for (const room of ['r1', 'r2', 'r3', 'r4']) {
      void scheduler.schedule(room, {
        call: call(room),
        finish: (label) => void done.push(label),
      });
    }
    await flush();
    expect(pending.size).toBe(2);
    expect(scheduler.inFlight).toBe(2);

    pending.get('r1')!();
    await flush();
    expect(pending.size).toBe(3); // r3 took the freed slot
    expect(scheduler.inFlight).toBe(2);
  });

  it('keeps a room in order even when a later line would translate faster', async () => {
    const scheduler = new TranslationScheduler(4);
    const { pending, call } = controllable();
    const emitted: string[] = [];
    const all = ['one', 'two', 'three'].map((label) =>
      scheduler.schedule('hall', {
        call: call(label),
        finish: (result) => void emitted.push(result),
      }),
    );
    await flush();
    // only the first is in flight: the room is serial
    expect([...pending.keys()]).toEqual(['one']);
    pending.get('one')!();
    await flush();
    pending.get('two')!();
    await flush();
    pending.get('three')!();
    await Promise.all(all);
    expect(emitted).toEqual(['one', 'two', 'three']);
  });

  it('skips the call when prepare says nobody is listening', async () => {
    const scheduler = new TranslationScheduler(1);
    const call = jest.fn().mockResolvedValue('x');
    await scheduler.schedule('hall', {
      prepare: () => false,
      call,
      finish: () => {},
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('drops the oldest queued line when a room backs up', async () => {
    const scheduler = new TranslationScheduler(1, 2);
    const { pending, call } = controllable();
    const dropped: string[] = [];
    const emitted: string[] = [];
    const schedule = (label: string) =>
      scheduler.schedule('hall', {
        call: call(label),
        finish: (r) => void emitted.push(r),
        onDrop: () => dropped.push(label),
      });
    const all = [schedule('a')];
    await flush();
    // 'a' is running; b, c, d queue behind it with room for two
    all.push(schedule('b'), schedule('c'), schedule('d'));
    for (const label of ['a', 'c', 'd']) {
      await flush();
      pending.get(label)?.();
      await flush();
    }
    await Promise.all(all);
    expect(dropped).toEqual(['b']);
    expect(emitted).toEqual(['a', 'c', 'd']);
  });
});

describe('InterimThrottle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup() {
    const sent: string[] = [];
    const throttle = new InterimThrottle<string>(
      (_room, text) => sent.push(text),
      500,
      () => Date.now(),
    );
    return { sent, throttle };
  }

  it('sends at most two interims a second, the newest one in each window', () => {
    const { sent, throttle } = setup();
    let event = 0;
    // ten revisions over one second
    for (let i = 0; i < 10; i++) {
      throttle.interim('hall', `rev${i}`, ++event);
      jest.advanceTimersByTime(100);
    }
    jest.advanceTimersByTime(500);
    // rev0 at once; rev4 is the newest when the window reopens at 500ms; rev9 at 1000ms
    expect(sent).toEqual(['rev0', 'rev4', 'rev9']);
  });

  it('sends a final immediately and discards the interim it replaced', () => {
    const { sent, throttle } = setup();
    throttle.interim('hall', 'hel', 1);
    throttle.interim('hall', 'hello wor', 2); // held
    throttle.final('hall', 'Hello world.', 3);
    jest.advanceTimersByTime(1000);
    expect(sent).toEqual(['hel', 'Hello world.']);
  });

  it('drops an interim older than the last final', () => {
    const { sent, throttle } = setup();
    throttle.final('hall', 'Final.', 5);
    jest.advanceTimersByTime(1000);
    throttle.interim('hall', 'stale', 4);
    throttle.interim('hall', 'next', 6);
    expect(sent).toEqual(['Final.', 'next']);
  });

  it('throttles rooms independently', () => {
    const { sent, throttle } = setup();
    throttle.interim('a', 'a1', 1);
    throttle.interim('b', 'b1', 2);
    expect(sent).toEqual(['a1', 'b1']);
  });
});

describe('SeqClock', () => {
  it('is strictly increasing per room even within one millisecond', () => {
    const clock = new SeqClock(() => 1000);
    expect([clock.next('a'), clock.next('a'), clock.next('b')]).toEqual([
      1000, 1001, 1000,
    ]);
  });
});
