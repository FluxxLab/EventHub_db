import { CaptionsService, CAPTURE_DESKS_ROOM } from './captions.service';
import type { TranscriptEvent } from './transcription/transcription.interface';
import { CaptionLanguage } from './translation/languages';

/** In-memory Redis covering what CaptionsService touches. */
class FakeRedis {
  kv = new Map<string, string>();
  expiry = new Map<string, number>();
  hashes = new Map<string, Map<string, number>>();

  private alive(key: string) {
    const at = this.expiry.get(key);
    if (at !== undefined && at <= Date.now()) {
      this.kv.delete(key);
      this.expiry.delete(key);
    }
    return this.kv.has(key);
  }

  set(key: string, value: string, ...args: (string | number)[]) {
    const nx = args.includes('NX');
    if (nx && this.alive(key)) return Promise.resolve(null);
    this.kv.set(key, value);
    const px = args.indexOf('PX');
    const ex = args.indexOf('EX');
    if (px !== -1) this.expiry.set(key, Date.now() + Number(args[px + 1]));
    else if (ex !== -1)
      this.expiry.set(key, Date.now() + Number(args[ex + 1]) * 1000);
    return Promise.resolve('OK');
  }
  get(key: string) {
    return Promise.resolve(this.alive(key) ? this.kv.get(key)! : null);
  }
  pttl(key: string) {
    return Promise.resolve(
      this.alive(key) ? (this.expiry.get(key) ?? 0) - Date.now() : -2,
    );
  }
  del(...keys: string[]) {
    keys.forEach((key) => this.kv.delete(key));
    return Promise.resolve(keys.length);
  }
  eval(script: string, _n: number, key: string, owner: string, ttl?: number) {
    if (!this.alive(key) || this.kv.get(key) !== owner)
      return Promise.resolve(0);
    if (script.includes('pexpire'))
      this.expiry.set(key, Date.now() + Number(ttl));
    else this.kv.delete(key);
    return Promise.resolve(1);
  }
  mget(...keys: string[]) {
    return Promise.resolve(
      keys.map((k) => (this.alive(k) ? this.kv.get(k)! : null)),
    );
  }
  pipeline() {
    const ops: (() => void)[] = [];
    const chain = {
      set: (k: string, v: string) => {
        ops.push(() => this.kv.set(k, v));
        return chain;
      },
      exec: () => {
        ops.forEach((op) => op());
        return Promise.resolve([]);
      },
    };
    return chain;
  }
  hincrby(key: string, field: string, by: number) {
    const hash = this.hashes.get(key) ?? new Map<string, number>();
    this.hashes.set(key, hash);
    hash.set(field, (hash.get(field) ?? 0) + by);
    return Promise.resolve(hash.get(field)!);
  }
  hset(key: string, field: string, value: number) {
    this.hashes.get(key)?.set(field, value);
    return Promise.resolve(1);
  }
  hgetall(key: string) {
    return Promise.resolve(Object.fromEntries(this.hashes.get(key) ?? []));
  }
  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      hincrby: (k: string, f: string, by: number) => {
        ops.push(() => this.hincrby(k, f, by));
        return chain;
      },
      expire: () => chain,
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function build(redis = new FakeRedis(), settings: Record<string, string> = {}) {
  let onTranscript: ((event: TranscriptEvent) => void) | undefined;
  const stream = {
    sendAudio: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const transcription = {
    openStream: jest.fn(
      (_opts: unknown, cb: (event: TranscriptEvent) => void) => {
        onTranscript = cb;
        return Promise.resolve(stream);
      },
    ),
  };
  const translation = { translate: jest.fn() };
  const segments = {
    insert: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn((v: unknown) => v),
  };
  const session = { findLiveInRoom: jest.fn().mockResolvedValue({ id: 's1' }) };
  const realtime = { emitToRoom: jest.fn(), emitGlobal: jest.fn() };
  const archiveQueue = { add: jest.fn().mockResolvedValue({}) };
  const service = new CaptionsService(
    segments as never,
    transcription,
    translation,
    archiveQueue as never,
    { add: jest.fn() } as never,
    session as never,
    realtime as never,
    redis as never,
    {
      get: (key: string) =>
        settings[key] ?? (key === 'TRANSLATION_CONCURRENCY' ? '2' : undefined),
    } as never,
  );
  return {
    service,
    redis,
    stream,
    transcription,
    translation,
    segments,
    realtime,
    archiveQueue,
    session,
    say: (event: TranscriptEvent) => onTranscript!(event),
  };
}

const captions = (realtime: { emitToRoom: jest.Mock }) =>
  realtime.emitToRoom.mock.calls.filter(([, event]) => event === 'caption');

describe('CaptionsService capture lock', () => {
  afterEach(() => jest.useRealTimers());

  it('refuses a second instance while the first holds the room, then lets it take over', async () => {
    const redis = new FakeRedis();
    const a = build(redis);
    const b = build(redis);

    await expect(
      a.service.startRoom('Main Hall', true, 'desk-a'),
    ).resolves.toEqual({ ok: true });
    const refused = await b.service.startRoom('Main Hall', true, 'desk-b');
    expect(refused).toMatchObject({ ok: false, holder: a.service.instanceId });
    expect(b.transcription.openStream).not.toHaveBeenCalled();

    await a.service.stopRoom('Main Hall');
    await expect(
      b.service.startRoom('Main Hall', true, 'desk-b'),
    ).resolves.toEqual({ ok: true });
    expect(b.transcription.openStream).toHaveBeenCalledTimes(1);
    await b.service.stopRoom('Main Hall');
  });

  it('treats differently spelled rooms as one, with one stream and one status key', async () => {
    const t = build();
    await t.service.startRoom('Main Hall', true, 'desk-1');
    await t.service.startRoom(' main hall', true, 'desk-2');
    expect(t.transcription.openStream).toHaveBeenCalledTimes(1);
    t.service.sendAudio('MAIN HALL', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]));
    expect(t.stream.sendAudio).toHaveBeenCalledTimes(1);
    await expect(t.redis.get('capture:room:main hall')).resolves.not.toBeNull();
    await t.service.stopRoom('main hall ');
    expect(t.service.isHeld('Main Hall')).toBe(false);
    await expect(t.redis.get('capture:room:main hall')).resolves.toBeNull();
  });

  it('rejoins the running stream on the same instance', async () => {
    const t = build();
    await t.service.startRoom('Hall B', true, 'desk-1');
    await t.service.startRoom('Hall B', true, 'desk-2');
    expect(t.transcription.openStream).toHaveBeenCalledTimes(1);
    await t.service.stopRoom('Hall B');
  });

  it('stops the room after the grace period when the desk disconnects and does not return', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    await t.service.startRoom('Hall B', true, 'desk-1');
    t.service.captureSocketLeft('Hall B', 'desk-1');

    await jest.advanceTimersByTimeAsync(CaptionsService.CAPTURE_GRACE_MS - 1);
    expect(t.stream.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(t.stream.close).toHaveBeenCalled();
    expect(t.service.isActive('Hall B')).toBe(false);
    // lock released: another instance can start straight away
    const other = build(t.redis);
    await expect(other.service.startRoom('Hall B')).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps the room when the desk reconnects within the grace period', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    await t.service.startRoom('Hall B', true, 'desk-1');
    t.service.captureSocketLeft('Hall B', 'desk-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await t.service.startRoom('Hall B', true, 'desk-1b');
    await jest.advanceTimersByTimeAsync(CaptionsService.CAPTURE_GRACE_MS * 2);
    expect(t.stream.close).not.toHaveBeenCalled();
    expect(t.service.isActive('Hall B')).toBe(true);
  });

  it('sends capture:restart to capture desks only', async () => {
    const t = build();
    await t.service.startRoom('Hall B');
    const opts = t.transcription.openStream.mock.calls[0][0] as {
      onReopen: () => void;
    };
    opts.onReopen();
    expect(t.realtime.emitToRoom).toHaveBeenCalledWith(
      CAPTURE_DESKS_ROOM,
      'capture:restart',
      {
        room: 'Hall B',
      },
    );
    expect(t.realtime.emitGlobal).not.toHaveBeenCalled();
    await t.service.stopRoom('Hall B');
  });
});

describe('CaptionsService capture sources', () => {
  const PCM = {
    encoding: 'linear16',
    sampleRate: 16_000,
    channels: 1,
  } as const;

  it('refuses a desk while the venue stream holds the room on the same instance, however the room is typed', async () => {
    const t = build();
    await expect(
      t.service.startRoom('Main Hall', true, undefined, {
        source: 'ingest',
        audio: PCM,
      }),
    ).resolves.toEqual({ ok: true });

    const refused = await t.service.startRoom(' main hall ', true, 'desk-1');
    expect(refused).toMatchObject({ ok: false, holder: 'the venue stream' });
    expect(t.transcription.openStream).toHaveBeenCalledTimes(1);
    expect(t.service.sourceOf('MAIN HALL')).toBe('ingest');
    await t.service.stopRoom('Main Hall');
    expect(t.service.sourceOf('Main Hall')).toBeNull();
  });

  it('refuses the venue stream while a desk holds the room, then lets it in once the desk stops', async () => {
    const t = build();
    await t.service.startRoom('Hall B', true, 'desk-1');
    const refused = await t.service.startRoom('Hall B', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    expect(refused).toMatchObject({ ok: false, holder: 'a capture desk' });

    await t.service.stopRoom('Hall B');
    await expect(
      t.service.startRoom('Hall B', true, undefined, {
        source: 'ingest',
        audio: PCM,
      }),
    ).resolves.toEqual({ ok: true });
    await t.service.stopRoom('Hall B');
  });

  it('tells the provider the raw format, and never asks desks to restart for it', async () => {
    const t = build();
    await t.service.startRoom('Hall C', false, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    const opts = t.transcription.openStream.mock.calls[0][0] as {
      audio?: unknown;
      onReopen?: unknown;
    };
    expect(opts.audio).toEqual(PCM);
    expect(opts.onReopen).toBeUndefined();
    await t.service.stopRoom('Hall C');
  });

  it('publishes where the audio comes from for live ops, and clears it on stop', async () => {
    const t = build();
    await t.service.startRoom('Hall D', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    await expect(t.service.liveSource('Hall D')).resolves.toBe('ingest');
    await t.service.stopRoom('Hall D');
    await expect(t.service.liveSource('Hall D')).resolves.toBeNull();

    await t.service.startRoom('Hall D', true, 'desk-1');
    await expect(t.service.liveSource('Hall D')).resolves.toBe('desk');
    await t.service.stopRoom('Hall D');
  });
});

describe('CaptionsService live pipeline', () => {
  it('emits a final with a seq, and its translations carry the same seq and time', async () => {
    const t = build();
    await t.service.addListener('s1', 'ha');
    t.translation.translate.mockResolvedValue({ ha: 'Sannu' });
    await t.service.startRoom('Hall B');

    t.say({ text: 'Hello', isFinal: true, speaker: 0 });
    await flush();

    const [english, hausa] = captions(t.realtime);
    expect(english[0]).toBe('captions:s1');
    expect(hausa[0]).toBe('captions:s1:ha');
    const en = english[2] as { seq: number; at: string };
    const ha = hausa[2] as { seq: number; at: string };
    expect(typeof en.seq).toBe('number');
    expect(ha.seq).toBe(en.seq);
    expect(ha.at).toBe(en.at);
    // only the language being read was asked for
    expect(t.translation.translate).toHaveBeenCalledWith(
      'Hello',
      [],
      [CaptionLanguage.HA],
    );
    await t.service.stopRoom('Hall B');
  });

  it('does not translate when nobody is reading a translation', async () => {
    const t = build();
    await t.service.startRoom('Hall B');
    t.say({ text: 'Hello', isFinal: true });
    await flush();
    expect(t.translation.translate).not.toHaveBeenCalled();
    expect(captions(t.realtime)).toHaveLength(1);
    await t.service.stopRoom('Hall B');
  });

  it('retries a failed translation once, then persists nothing', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const t = build();
      await t.service.addListener('s1', 'yo');
      t.translation.translate.mockRejectedValue(new Error('overloaded'));
      await t.service.startRoom('Hall B');
      t.say({ text: 'Hello', isFinal: true });
      await jest.advanceTimersByTimeAsync(CaptionsService.TRANSLATE_RETRY_MS);
      await flush();
      expect(t.translation.translate).toHaveBeenCalledTimes(2);
      // the English row only
      expect(t.segments.insert).toHaveBeenCalledTimes(1);
      expect(captions(t.realtime)).toHaveLength(1);
      await t.service.stopRoom('Hall B');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never emits an interim after the final that replaced it', async () => {
    const t = build();
    await t.service.startRoom('Hall B');
    t.say({ text: 'Hel', isFinal: false });
    t.say({ text: 'Hello wor', isFinal: false }); // held by the throttle
    t.say({ text: 'Hello world.', isFinal: true });
    await flush();
    await new Promise((resolve) =>
      setTimeout(resolve, CaptionsService.INTERIM_INTERVAL_MS + 50),
    );
    const texts = captions(t.realtime).map(
      ([, , p]) => (p as { text: string }).text,
    );
    expect(texts).toEqual(['Hel', 'Hello world.']);
    await t.service.stopRoom('Hall B');
  });
});

describe('CaptionsService transcribes only while a session is live', () => {
  const PCM = {
    encoding: 'linear16',
    sampleRate: 16_000,
    channels: 1,
  } as const;
  const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]);
  const midContainer = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 9]);

  it('holds a room with nothing live without opening Deepgram, then opens when a session goes live', async () => {
    const t = build();
    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.startRoom('Hall E', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    expect(t.service.isHeld('Hall E')).toBe(true);
    expect(t.transcription.openStream).not.toHaveBeenCalled();
    t.service.sendAudio('Hall E', Buffer.alloc(320));
    expect(t.stream.sendAudio).not.toHaveBeenCalled(); // nobody pays for a break

    t.session.findLiveInRoom.mockResolvedValue({ id: 'keynote' });
    await t.service.syncRoom('Hall E');
    expect(t.transcription.openStream).toHaveBeenCalledTimes(1);
    expect(t.session.findLiveInRoom).toHaveBeenLastCalledWith('Hall E', true);
    t.service.sendAudio('Hall E', Buffer.alloc(320));
    // the idle chunk comes first, as pre-roll, then the live one
    expect(t.stream.sendAudio).toHaveBeenCalledTimes(2);
    await t.service.stopRoom('Hall E');
  });

  it('closes and archives when the session ends, and starts afresh for the next one', async () => {
    const t = build();
    t.session.findLiveInRoom.mockResolvedValue({ id: 'panel-1' });
    await t.service.startRoom('Hall F', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    t.service.sendAudio('Hall F', Buffer.alloc(320));

    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.syncRoom('Hall F');
    expect(t.stream.close).toHaveBeenCalledTimes(1);
    expect(t.service.isActive('Hall F')).toBe(false);
    expect(t.service.isHeld('Hall F')).toBe(true);
    expect(t.archiveQueue.add).toHaveBeenCalledWith(
      'retranscribe',
      expect.objectContaining({ sessionId: 'panel-1', room: 'Hall F' }),
    );

    t.session.findLiveInRoom.mockResolvedValue({ id: 'panel-2' });
    await t.service.syncRoom('Hall F');
    expect(t.transcription.openStream).toHaveBeenCalledTimes(2);
    // a straight switch from one session to the next also starts over
    t.session.findLiveInRoom.mockResolvedValue({ id: 'panel-3' });
    await t.service.syncRoom('Hall F');
    expect(t.transcription.openStream).toHaveBeenCalledTimes(3);
    expect(t.archiveQueue.add).toHaveBeenLastCalledWith(
      'retranscribe',
      expect.objectContaining({ sessionId: 'panel-2' }),
    );
    await t.service.stopRoom('Hall F');
  });

  it('asks a desk for a fresh recording and drops audio until its header arrives', async () => {
    const t = build();
    await t.service.startRoom('Hall G', true, 'desk-1');
    expect(t.realtime.emitToRoom).toHaveBeenCalledWith(
      CAPTURE_DESKS_ROOM,
      'capture:restart',
      { room: 'Hall G' },
    );
    t.service.sendAudio('Hall G', midContainer);
    expect(t.stream.sendAudio).not.toHaveBeenCalled();
    t.service.sendAudio('Hall G', EBML);
    t.service.sendAudio('Hall G', midContainer);
    expect(t.stream.sendAudio).toHaveBeenCalledTimes(2);
    expect(t.stream.sendAudio).toHaveBeenNthCalledWith(1, EBML);
    await t.service.stopRoom('Hall G');
  });

  it('never asks the venue stream to restart', async () => {
    const t = build();
    await t.service.startRoom('Hall H', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    expect(t.realtime.emitToRoom).not.toHaveBeenCalledWith(
      CAPTURE_DESKS_ROOM,
      'capture:restart',
      expect.anything(),
    );
    t.service.sendAudio('Hall H', midContainer);
    expect(t.stream.sendAudio).toHaveBeenCalledTimes(1);
    await t.service.stopRoom('Hall H');
  });

  it('keeps captioning but skips the recording when the disk is nearly full', async () => {
    // more free space required than any disk has
    const t = build(undefined, { CAPTIONS_MIN_FREE_DISK_MB: '1e12' });
    await t.service.startRoom('Hall I', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    t.service.sendAudio('Hall I', Buffer.alloc(320));
    expect(t.stream.sendAudio).toHaveBeenCalledTimes(1);
    await t.service.stopRoom('Hall I');
    expect(t.archiveQueue.add).not.toHaveBeenCalled();
  });
});

describe('CaptionsService pre-roll for venue streams', () => {
  const PCM = {
    encoding: 'linear16',
    sampleRate: 16_000,
    channels: 1,
  } as const;
  const second = (fill: number) => Buffer.alloc(32_000, fill); // 1 s of 16 kHz mono PCM

  it('replays the last 3 s before a session went live, oldest first', async () => {
    const t = build();
    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.startRoom('Hall P', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    for (let i = 1; i <= 5; i++) t.service.sendAudio('Hall P', second(i));

    t.session.findLiveInRoom.mockResolvedValue({ id: 'opening' });
    await t.service.syncRoom('Hall P');
    const sent = t.stream.sendAudio.mock.calls.map(
      ([chunk]: [Buffer]) => chunk[0],
    );
    expect(sent).toEqual([3, 4, 5]);
    await t.service.stopRoom('Hall P');
  });

  it('keeps no pre-roll for a desk', async () => {
    const t = build();
    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.startRoom('Hall Q', true, 'desk-1');
    t.service.sendAudio('Hall Q', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    t.session.findLiveInRoom.mockResolvedValue({ id: 'talk' });
    await t.service.syncRoom('Hall Q');
    expect(t.stream.sendAudio).not.toHaveBeenCalled();
    await t.service.stopRoom('Hall Q');
  });
});

describe('CaptionsService pre-roll window', () => {
  const PCM = {
    encoding: 'linear16',
    sampleRate: 16_000,
    channels: 1,
  } as const;
  afterEach(() => jest.useRealTimers());

  it('replays only audio from the last sync interval and a second, not an earlier speaker', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build(undefined, { CAPTIONS_SYNC_MS: '2000' });
    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.startRoom('Hall R', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    t.service.sendAudio('Hall R', Buffer.alloc(320, 1)); // the last speaker, after their session ended
    jest.advanceTimersByTime(3_500);
    t.service.sendAudio('Hall R', Buffer.alloc(320, 2)); // the new session's opening words

    t.session.findLiveInRoom.mockResolvedValue({ id: 'next' });
    await t.service.syncRoom('Hall R');
    const sent = t.stream.sendAudio.mock.calls.map(
      ([chunk]: [Buffer]) => chunk[0],
    );
    expect(sent).toEqual([2]);
    await t.service.stopRoom('Hall R');
  });

  it('starts a room taken again with no pre-roll from before', async () => {
    const t = build();
    t.session.findLiveInRoom.mockResolvedValue({ id: 'first' });
    await t.service.startRoom('Hall S', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    t.session.findLiveInRoom.mockResolvedValue(null);
    await t.service.syncRoom('Hall S');
    t.service.sendAudio('Hall S', Buffer.alloc(320, 7));
    // stopped and taken again: nothing from before carries over
    await t.service.stopRoom('Hall S');
    t.session.findLiveInRoom.mockResolvedValue({ id: 'second' });
    t.stream.sendAudio.mockClear();
    await t.service.startRoom('Hall S', true, undefined, {
      source: 'ingest',
      audio: PCM,
    });
    expect(t.stream.sendAudio).not.toHaveBeenCalled();
    await t.service.stopRoom('Hall S');
  });
});
