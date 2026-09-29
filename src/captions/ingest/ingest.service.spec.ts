import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/** A LiveKit audio track whose frames the test pushes in. */
class FakeTrack {
  kind = 1; // KIND_AUDIO
  private frames: { data: Int16Array }[] = [];
  private wake: (() => void) | null = null;
  ended = false;
  push(samples: number[]) {
    this.frames.push({ data: Int16Array.from(samples) });
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *read() {
    for (;;) {
      const frame = this.frames.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

const rooms: FakeRoom[] = [];
class FakeRoom extends EventEmitter {
  connect = jest.fn().mockResolvedValue(undefined);
  disconnect = jest.fn().mockResolvedValue(undefined);
  constructor() {
    super();
    rooms.push(this);
  }
}

jest.mock('@livekit/rtc-node', () => ({
  Room: jest.fn(() => new FakeRoom()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    Disconnected: 'disconnected',
  },
  TrackKind: { KIND_AUDIO: 1 },
  AudioStream: jest.fn((track: FakeTrack) => track.read()),
}));

import { IngressInput } from 'livekit-server-sdk';
import { INGEST_AUDIO, IngestService } from './ingest.service';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const ingress = (room: string, over: Record<string, unknown> = {}) => ({
  ingressId: `IN_${room}`,
  name: `pic-room:${room}`,
  url: 'rtmps://example.livekit.cloud/x',
  streamKey: 'secret-key',
  inputType: IngressInput.RTMP_INPUT,
  participantMetadata: JSON.stringify({ diarise: true }),
  state: { status: 2 },
  ...over,
});

function build({
  enabled = true,
  settings = {},
}: { enabled?: boolean; settings?: Record<string, string> } = {}) {
  const client = {
    listIngress: jest.fn().mockResolvedValue([]),
    createIngress: jest.fn((_input: unknown, opts: { name: string }) =>
      Promise.resolve(
        ingress(opts.name.slice('pic-room:'.length), { state: undefined }),
      ),
    ),
    deleteIngress: jest.fn().mockResolvedValue({}),
  };
  const receiver = { receive: jest.fn() };
  const livekit = {
    isConfigured: () => true,
    ingressClient: () => client,
    webhookReceiver: () => receiver,
    serverUrl: () => 'wss://example.livekit.cloud',
    ingestListenerToken: jest.fn().mockResolvedValue('token'),
  };
  const sources = new Map<string, string>();
  const captions = {
    instanceId: 'test',
    startRoom: jest.fn((room: string) => {
      sources.set(room, 'ingest');
      return Promise.resolve({ ok: true });
    }),
    stopRoom: jest.fn((room: string) => {
      sources.delete(room);
      return Promise.resolve();
    }),
    sendAudio: jest.fn(),
    sourceOf: jest.fn((room: string) => sources.get(room) ?? null),
    liveSource: jest.fn().mockResolvedValue(null),
  };
  const editions = {
    current: jest.fn().mockResolvedValue({ id: 'ed1' }),
  };
  const venue = {
    list: jest
      .fn()
      .mockResolvedValue([{ name: 'Main Hall' }, { name: 'Hall A' }]),
  };
  const config = {
    get: (k: string) =>
      k === 'INGEST_ENABLED' ? (enabled ? 'true' : undefined) : settings[k],
  };
  const service = new IngestService(
    config as never,
    livekit as never,
    captions as never,
    editions as never,
    venue as never,
  );
  return { service, client, receiver, captions, sources };
}

/** The venue stream appears in the LiveKit room the service joined. */
function publish(room: FakeRoom, identity = 'ingress:main hall') {
  const track = new FakeTrack();
  room.emit('trackSubscribed', track, {}, { identity });
  return track;
}

describe('IngestService', () => {
  beforeEach(() => {
    rooms.length = 0;
  });
  afterEach(() => jest.useRealTimers());

  it('claims the room, then joins and sends the venue stream as 16 kHz PCM', async () => {
    const t = build();
    t.service.listen('Main Hall', true);
    await flush();
    expect(t.captions.startRoom).toHaveBeenCalledWith(
      'Main Hall',
      true,
      undefined,
      { source: 'ingest', audio: INGEST_AUDIO },
    );
    expect(rooms).toHaveLength(1);
    expect(rooms[0].connect).toHaveBeenCalledWith(
      'wss://example.livekit.cloud',
      'token',
      expect.objectContaining({ autoSubscribe: true }),
    );

    const track = publish(rooms[0]);
    track.push([1, -1, 256]);
    await flush();
    const sent = t.captions.sendAudio.mock.calls[0] as [string, Buffer];
    expect(sent[0]).toBe('Main Hall');
    expect([...new Int16Array(sent[1].buffer, sent[1].byteOffset, 3)]).toEqual([
      1, -1, 256,
    ]);
    track.end();
  });

  it('ignores tracks that are not the venue stream', async () => {
    const t = build();
    t.service.listen('Main Hall', true);
    await flush();
    const other = publish(rooms[0], 'capture:someone');
    other.push([1]);
    await flush();
    expect(t.captions.sendAudio).not.toHaveBeenCalled();
    other.end();
  });

  it('does not join while a desk or another replica holds the room, and takes over when it stops', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    t.captions.startRoom.mockResolvedValueOnce({
      ok: false,
      holder: 'a capture desk',
      retryAfterMs: 15_000,
    } as never);
    t.service.listen('Main Hall', true);
    await flush();
    expect(rooms).toHaveLength(0); // no listener paid for while refused

    await jest.advanceTimersByTimeAsync(IngestService.RETRY_MS);
    await flush();
    expect(t.captions.startRoom).toHaveBeenCalledTimes(2);
    expect(rooms).toHaveLength(1);
    const track = publish(rooms[0]);
    track.push([6]);
    await flush();
    expect(t.captions.sendAudio).toHaveBeenCalledTimes(1);
    track.end();
  });

  it('lets the room go after the grace period when the stream drops, unless it comes back', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    t.service.listen('Main Hall', true);
    await flush();
    const first = publish(rooms[0]);
    await flush();

    rooms[0].emit('trackUnsubscribed', first);
    await jest.advanceTimersByTimeAsync(IngestService.GRACE_MS - 1);
    publish(rooms[0]); // back in time
    await jest.advanceTimersByTimeAsync(IngestService.GRACE_MS);
    expect(t.captions.stopRoom).not.toHaveBeenCalled();

    const again = publish(rooms[0]);
    rooms[0].emit('trackUnsubscribed', again);
    await jest.advanceTimersByTimeAsync(IngestService.GRACE_MS);
    await flush();
    expect(t.captions.stopRoom).toHaveBeenCalledWith('Main Hall');
    expect(rooms[0].disconnect).toHaveBeenCalled();
  });

  it('does not stop a room a desk has since taken', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    t.service.listen('Main Hall', true);
    await flush();
    const track = publish(rooms[0]);
    await flush();
    t.sources.set('Main Hall', 'desk');
    rooms[0].emit('trackUnsubscribed', track);
    await jest.advanceTimersByTimeAsync(IngestService.GRACE_MS);
    await flush();
    expect(t.captions.stopRoom).not.toHaveBeenCalled();
  });

  describe('webhook', () => {
    it('rejects a bad signature', async () => {
      const t = build();
      t.receiver.receive.mockRejectedValue(new Error('invalid'));
      await expect(t.service.webhook('{}', 'bad')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('starts listening on ingress_started and ignores other events', async () => {
      const t = build();
      t.receiver.receive.mockResolvedValueOnce({
        event: 'room_started',
      });
      await t.service.webhook('{}', 'sig');
      expect(rooms).toHaveLength(0);

      t.receiver.receive.mockResolvedValueOnce({
        event: 'ingress_started',
        ingressInfo: ingress('Hall A'),
      });
      await t.service.webhook('{}', 'sig');
      await flush();
      expect(rooms).toHaveLength(1);
    });

    it('does nothing while venue streams are disabled', async () => {
      const t = build({ enabled: false });
      await t.service.webhook('{}', 'sig');
      expect(t.receiver.receive).not.toHaveBeenCalled();
    });
  });

  describe('console', () => {
    it('issues a stream only for a venue room, spelled as the venue spells it', async () => {
      const t = build();
      await expect(
        t.service.create('TBC', 'rtmp', true),
      ).rejects.toBeInstanceOf(BadRequestException);

      const created = await t.service.create(' main hall ', 'rtmp', false);
      expect(created).toMatchObject({
        room: 'Main Hall',
        input: 'rtmp',
        streamKey: 'secret-key',
      });
      expect(t.client.createIngress).toHaveBeenCalledWith(
        IngressInput.RTMP_INPUT,
        expect.objectContaining({
          name: 'pic-room:Main Hall',
          roomName: 'audio:main hall',
          participantIdentity: 'ingress:main hall',
          participantMetadata: expect.stringContaining(
            '"diarise":false',
          ) as unknown,
          enableTranscoding: true,
        }),
      );
    });

    it('skips transcoding for WHIP and refuses a second stream for a room', async () => {
      const t = build();
      await t.service.create('Hall A', 'whip', true);
      expect(t.client.createIngress).toHaveBeenCalledWith(
        IngressInput.WHIP_INPUT,
        expect.objectContaining({ enableTranscoding: false }),
      );
      t.client.listIngress.mockResolvedValue([ingress('Hall A')]);
      await expect(
        t.service.create('Hall A', 'rtmp', true),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lists rooms with their stream state but never the key', async () => {
      const t = build();
      t.client.listIngress.mockResolvedValue([ingress('Main Hall')]);
      t.captions.liveSource.mockResolvedValueOnce('ingest');
      const list = await t.service.list();
      expect(list).toEqual([
        {
          room: 'Main Hall',
          stream: {
            id: 'IN_Main Hall',
            input: 'rtmp',
            url: 'rtmps://example.livekit.cloud/x',
            state: 'publishing',
            diarise: true,
          },
          captioning: 'ingest',
        },
        { room: 'Hall A', stream: null, captioning: null },
      ]);
      expect(JSON.stringify(list)).not.toContain('secret-key');
    });

    it('rotates by creating the new stream before revoking the old, keeping its settings', async () => {
      const t = build();
      t.client.listIngress.mockResolvedValue([ingress('Main Hall')]);
      const order: string[] = [];
      t.client.createIngress.mockImplementation(
        (_input: unknown, opts: { name: string }) => {
          order.push('create');
          return Promise.resolve(ingress(opts.name.slice('pic-room:'.length)));
        },
      );
      t.client.deleteIngress.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve({});
      });
      await t.service.rotate('Main Hall');
      expect(order).toEqual(['create', 'delete']);
      expect(t.client.deleteIngress).toHaveBeenCalledWith('IN_Main Hall');
      expect(t.client.createIngress).toHaveBeenCalledWith(
        IngressInput.RTMP_INPUT,
        expect.objectContaining({
          participantMetadata: expect.stringContaining(
            '"diarise":true',
          ) as unknown,
        }),
      );
    });

    it('still hands over the new key when the old cannot be revoked, and reconcile revokes it later', async () => {
      const t = build();
      t.client.listIngress.mockResolvedValue([ingress('Main Hall')]);
      t.client.deleteIngress.mockRejectedValueOnce(new Error('LiveKit down'));
      await expect(t.service.rotate('Main Hall')).resolves.toMatchObject({
        streamKey: 'secret-key',
      });

      // both are listed now; the older one (no createdAt) is stale
      const newer = ingress('Main Hall', {
        ingressId: 'IN_new',
        participantMetadata: JSON.stringify({ diarise: true, createdAt: 5 }),
      });
      t.client.listIngress.mockResolvedValue([ingress('Main Hall'), newer]);
      t.client.deleteIngress.mockClear();
      await t.service.reconcile();
      expect(t.client.deleteIngress).toHaveBeenCalledWith('IN_Main Hall');
      expect(t.client.deleteIngress).not.toHaveBeenCalledWith('IN_new');
    });

    it('answers 503 while disabled', async () => {
      const t = build({ enabled: false });
      await expect(t.service.list()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  it('reconcile listens to publishing streams and lets stopped ones go', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build();
    t.client.listIngress.mockResolvedValue([
      ingress('Main Hall'),
      ingress('Hall A', { state: { status: 0 } }),
    ]);
    await t.service.reconcile();
    await flush();
    expect(rooms).toHaveLength(1); // Main Hall only

    t.client.listIngress.mockResolvedValue([
      ingress('Main Hall', { state: { status: 0 } }),
    ]);
    await t.service.reconcile();
    await jest.advanceTimersByTimeAsync(IngestService.GRACE_MS);
    await flush();
    expect(rooms[0].disconnect).toHaveBeenCalled();
  });

  it('reuses the stream list for a few seconds, and lists afresh after a change', async () => {
    const t = build();
    await t.service.list();
    await t.service.list();
    expect(t.client.listIngress).toHaveBeenCalledTimes(1);
    await t.service.create('Hall A', 'rtmp', true);
    const before = t.client.listIngress.mock.calls.length;
    await t.service.list();
    expect(t.client.listIngress.mock.calls.length).toBe(before + 1);
  });

  it('retries a refused room at the configured interval', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const t = build({ settings: { INGEST_RETRY_MS: '1000' } });
    t.captions.startRoom.mockResolvedValueOnce({
      ok: false,
      holder: 'a capture desk',
      retryAfterMs: 15_000,
    } as never);
    t.service.listen('Main Hall', true);
    await flush();
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(t.captions.startRoom).toHaveBeenCalledTimes(2);
  });
});
