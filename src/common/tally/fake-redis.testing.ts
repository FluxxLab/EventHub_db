/**
 * An in-memory stand-in for the handful of Redis commands LiveTallyService
 * uses, for unit tests. Expiry follows Date.now(), so jest's modern fake
 * timers drive it along with setTimeout.
 */
type Value = string | Map<string, string> | Set<string>;

export class FakeRedis {
  private readonly store = new Map<
    string,
    { value: Value; expiresAt?: number }
  >();
  /** Every command run, in order, for assertions such as "no GROUP BY, one HINCRBY". */
  readonly calls: Array<[string, ...unknown[]]> = [];

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private hash(key: string, create = false): Map<string, string> | undefined {
    const entry = this.live(key);
    if (entry) return entry.value as Map<string, string>;
    if (!create) return undefined;
    const value = new Map<string, string>();
    this.store.set(key, { value });
    return value;
  }

  private set_(key: string, create = false): Set<string> | undefined {
    const entry = this.live(key);
    if (entry) return entry.value as Set<string>;
    if (!create) return undefined;
    const value = new Set<string>();
    this.store.set(key, { value });
    return value;
  }

  set(key: string, value: string, ...args: Array<string | number>) {
    this.calls.push(['set', key, value, ...args]);
    const nx = args.includes('NX');
    const pxAt = args.indexOf('PX');
    if (nx && this.live(key)) return Promise.resolve(null);
    this.store.set(key, {
      value,
      expiresAt: pxAt >= 0 ? Date.now() + Number(args[pxAt + 1]) : undefined,
    });
    return Promise.resolve('OK');
  }

  hexists(key: string, field: string) {
    this.calls.push(['hexists', key, field]);
    return Promise.resolve(this.hash(key)?.has(field) ? 1 : 0);
  }

  hsetnx(key: string, field: string, value: string) {
    this.calls.push(['hsetnx', key, field, value]);
    const h = this.hash(key, true)!;
    if (h.has(field)) return Promise.resolve(0);
    h.set(field, value);
    return Promise.resolve(1);
  }

  hset(key: string, field: string, value: string) {
    this.calls.push(['hset', key, field, value]);
    this.hash(key, true)!.set(field, value);
    return Promise.resolve(1);
  }

  hincrby(key: string, field: string, by: number) {
    this.calls.push(['hincrby', key, field, by]);
    const h = this.hash(key, true)!;
    const next = Number(h.get(field) ?? 0) + by;
    h.set(field, String(next));
    return Promise.resolve(next);
  }

  hgetall(key: string) {
    this.calls.push(['hgetall', key]);
    return Promise.resolve(
      Object.fromEntries(this.hash(key) ?? new Map<string, string>()),
    );
  }

  del(...keys: string[]) {
    this.calls.push(['del', ...keys]);
    let n = 0;
    for (const key of keys) if (this.store.delete(key)) n++;
    return Promise.resolve(n);
  }

  pexpire(key: string, ms: number) {
    this.calls.push(['pexpire', key, ms]);
    const entry = this.live(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + ms;
    return Promise.resolve(1);
  }

  sadd(key: string, member: string) {
    this.calls.push(['sadd', key, member]);
    const s = this.set_(key, true)!;
    const had = s.has(member);
    s.add(member);
    return Promise.resolve(had ? 0 : 1);
  }

  spop(key: string, count: number) {
    this.calls.push(['spop', key, count]);
    const s = this.set_(key);
    if (!s) return Promise.resolve([]);
    const out = [...s].slice(0, count);
    for (const m of out) s.delete(m);
    if (s.size === 0) this.store.delete(key);
    return Promise.resolve(out);
  }

  /** Queues commands and runs them in order on exec, like MULTI/EXEC. */
  multi(): Record<string, (...args: unknown[]) => unknown> {
    const queued: Array<() => Promise<unknown>> = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'exec') {
            return async () => {
              const results: Array<[null, unknown]> = [];
              for (const run of queued) results.push([null, await run()]);
              return results;
            };
          }
          return (...args: unknown[]) => {
            const fn = (this as unknown as Record<string, unknown>)[prop];
            if (typeof fn !== 'function')
              throw new Error(`FakeRedis: ${prop} not supported`);
            const command = fn as (...a: unknown[]) => Promise<unknown>;
            queued.push(() => command.call(this, ...args) as Promise<unknown>);
            return chain;
          };
        },
      },
    );
    return chain;
  }

  /** Direct peek for assertions. */
  peekHash(key: string): Record<string, string> {
    return Object.fromEntries(this.hash(key) ?? new Map<string, string>());
  }
}
