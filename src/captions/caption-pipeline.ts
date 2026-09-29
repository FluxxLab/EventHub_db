/**
 * The small concurrency pieces the caption pipeline is built from.
 *
 * Kept apart from CaptionsService so each can be tested on its own with fake
 * timers and an in-memory Redis, without a Nest module or a database.
 */

/**
 * Runs tasks for the same key strictly one after another; different keys run
 * independently.
 *
 * Deepgram fires its callback synchronously for every fragment, and each
 * fragment's handling awaits (the room lookup, a Redis write). Without this,
 * two fragments for one room race each other, and an interim that started
 * before its final could finish after it - putting a half-sentence back on
 * the screen after the settled line had replaced it.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  run(
    key: string,
    task: () => Promise<void>,
    onError: (error: unknown) => void = () => {},
  ): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // previous never rejects (errors are handed to onError), so a failure in
    // one task cannot wedge every later task for the key.
    const tail = previous.then(task).catch(onError);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return tail;
  }

  /** How many keys currently have work queued or running. */
  get size(): number {
    return this.tails.size;
  }
}

/** A counting semaphore: at most `max` holders at once, the rest wait FIFO. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`semaphore size must be >= 1 (got ${max})`);
    }
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter, so `active` only drops
      // when nobody is queued.
      if (next) next();
      else this.active -= 1;
    }
  }

  get inUse(): number {
    return this.active;
  }
}

/**
 * Translation work: in order within a room, at most N calls in flight across
 * every room on this instance.
 *
 * In order, because each line is translated with the lines before it as
 * context and the English it follows is already on screen. Capped, because
 * ten rooms each finishing a sentence at the same moment is ten simultaneous
 * model calls, and the provider rate-limits long before that is useful.
 *
 * The backlog per room is bounded: if a room's speech outruns the translator,
 * the oldest queued line is dropped (and logged) rather than letting the
 * queue - and the delay between English and translation - grow without limit.
 * A dropped line is still recoverable: gap-fill translates it for any reader
 * who opens that language later.
 */
export class TranslationScheduler {
  private readonly serial = new KeyedSerializer();
  private readonly semaphore: Semaphore;
  private readonly backlog = new Map<string, { cancelled: boolean }[]>();

  constructor(
    concurrency: number,
    private readonly maxBacklog = 20,
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  /**
   * Queue `prepare` then `call` then `finish` for a room. Only `call` holds a
   * concurrency slot: reading listeners, persisting rows and emitting are
   * cheap and must not keep another room's translation waiting.
   *
   * `onDrop` fires if the job is pushed out of a full backlog before it ran.
   */
  schedule<T>(
    room: string,
    job: {
      call: () => Promise<T>;
      finish: (result: T) => Promise<void> | void;
      prepare?: () => Promise<boolean> | boolean;
      onDrop?: () => void;
      onError?: (error: unknown) => void;
    },
  ): Promise<void> {
    const queue = this.backlog.get(room) ?? [];
    this.backlog.set(room, queue);
    const ticket = { cancelled: false };
    queue.push(ticket);
    // Oldest queued-but-not-started work goes first; the running one (index 0
    // once started) is removed from the queue below, so it is never dropped.
    while (queue.length > this.maxBacklog) {
      const dropped = queue.shift();
      if (dropped) dropped.cancelled = true;
    }

    return this.serial.run(
      room,
      async () => {
        const index = queue.indexOf(ticket);
        if (index !== -1) queue.splice(index, 1);
        if (queue.length === 0 && this.backlog.get(room) === queue) {
          this.backlog.delete(room);
        }
        if (ticket.cancelled) {
          job.onDrop?.();
          return;
        }
        if (job.prepare && !(await job.prepare())) return;
        const result = await this.semaphore.use(job.call);
        await job.finish(result);
      },
      job.onError,
    );
  }

  get inFlight(): number {
    return this.semaphore.inUse;
  }
}

/**
 * Rate-limits interim (still-being-revised) caption lines per room.
 *
 * Deepgram revises an interim several times a second, and every revision was
 * a fan-out to every delegate reading that room - thousands of socket writes a
 * second for text that visibly rewrites itself. At most one interim per
 * `intervalMs` now goes out; revisions in between replace the held one, so
 * the newest text is what is sent when the window reopens.
 *
 * Finals are never delayed. A final also discards any interim still held, and
 * an interim that is older than the room's last final (by event number, which
 * is assigned when Deepgram delivered it) is dropped outright - the final has
 * already replaced it on screen.
 */
export class InterimThrottle<T> {
  private readonly rooms = new Map<
    string,
    {
      lastInterimAt: number;
      lastFinalEvent: number;
      held: { payload: T; event: number } | null;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  constructor(
    private readonly emit: (room: string, payload: T) => void,
    private readonly intervalMs = 500,
    private readonly now: () => number = Date.now,
  ) {}

  interim(room: string, payload: T, event: number): void {
    const state = this.state(room);
    if (event < state.lastFinalEvent) return;

    const since = this.now() - state.lastInterimAt;
    if (since >= this.intervalMs && !state.timer) {
      state.lastInterimAt = this.now();
      this.emit(room, payload);
      return;
    }

    state.held = { payload, event };
    if (state.timer) return;
    state.timer = setTimeout(
      () => {
        state.timer = null;
        const held = state.held;
        state.held = null;
        if (!held || held.event < state.lastFinalEvent) return;
        state.lastInterimAt = this.now();
        this.emit(room, held.payload);
      },
      Math.max(0, this.intervalMs - since),
    );
  }

  final(room: string, payload: T, event: number): void {
    const state = this.state(room);
    state.lastFinalEvent = Math.max(state.lastFinalEvent, event);
    state.held = null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.emit(room, payload);
  }

  clear(room: string): void {
    const state = this.rooms.get(room);
    if (state?.timer) clearTimeout(state.timer);
    this.rooms.delete(room);
  }

  private state(room: string) {
    let state = this.rooms.get(room);
    if (!state) {
      state = {
        lastInterimAt: Number.NEGATIVE_INFINITY,
        lastFinalEvent: Number.NEGATIVE_INFINITY,
        held: null,
        timer: null,
      };
      this.rooms.set(room, state);
    }
    return state;
  }
}

/**
 * The ordering key of a caption line: epoch milliseconds of when the English
 * was heard, forced strictly increasing per room so two fragments in the same
 * millisecond (a final split at a speaker change) keep their order.
 *
 * Wall-clock based rather than a counter so it survives a capture moving to
 * another API instance or a restart - a counter would start again at 1 and
 * sort every new line before the old ones.
 */
export class SeqClock {
  private readonly last = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  next(room: string): number {
    const seq = Math.max(this.now(), (this.last.get(room) ?? 0) + 1);
    this.last.set(room, seq);
    return seq;
  }

  forget(room: string): void {
    this.last.delete(room);
  }
}

/** The subset of ioredis the capture lock needs, so tests can fake it. */
export interface LockRedis {
  set(
    key: string,
    value: string,
    px: 'PX',
    ms: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/** Extend the TTL only if we still hold it. */
export const REFRESH_LOCK_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
/** Delete only if we still hold it - never another instance's lock. */
export const RELEASE_LOCK_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export type LockResult =
  { ok: true } | { ok: false; holder: string | null; retryAfterMs: number };

/**
 * One capture per room across every API instance.
 *
 * The Deepgram stream for a room lives in the process that holds the capture
 * desk's socket. The old guard was an in-memory map, so with two instances
 * behind the load balancer a desk reconnecting to the other one started a
 * second stream for the same room: every line captioned twice, and two
 * recordings each archiving half the session over the other.
 *
 * The lock is `capture:lock:<room>` = this instance's id, with a TTL refreshed
 * while audio flows. Another instance refuses capture:start until the holder
 * releases it (desk stopped, or its grace period after a disconnect ran out)
 * or the TTL lapses (the holder died) - at which point NX lets it take over.
 */
export class CaptureLock {
  constructor(
    private readonly redis: LockRedis,
    readonly instanceId: string,
    private readonly ttlMs = 30_000,
  ) {}

  /** Room names are matched loosely elsewhere (LOWER/TRIM); so is the lock. */
  key(room: string): string {
    return `capture:lock:${room.trim().toLowerCase()}`;
  }

  async acquire(room: string): Promise<LockResult> {
    const key = this.key(room);
    const set = await this.redis.set(
      key,
      this.instanceId,
      'PX',
      this.ttlMs,
      'NX',
    );
    if (set === 'OK') return { ok: true };
    // Already ours - a desk reconnecting to the same instance.
    if (await this.refresh(room)) return { ok: true };
    const [holder, pttl] = await Promise.all([
      this.redis.get(key),
      this.redis.pttl(key),
    ]);
    // Expired between the SET and the GET: try once more rather than refuse.
    if (holder === null) {
      const retry = await this.redis.set(
        key,
        this.instanceId,
        'PX',
        this.ttlMs,
        'NX',
      );
      if (retry === 'OK') return { ok: true };
    }
    return { ok: false, holder, retryAfterMs: Math.max(0, pttl) };
  }

  async refresh(room: string): Promise<boolean> {
    const result = await this.redis.eval(
      REFRESH_LOCK_SCRIPT,
      1,
      this.key(room),
      this.instanceId,
      this.ttlMs,
    );
    return Number(result) === 1;
  }

  async release(room: string): Promise<void> {
    await this.redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      this.key(room),
      this.instanceId,
    );
  }
}

/** Resolve after `ms`. Exported so retry paths can be driven by fake timers. */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
