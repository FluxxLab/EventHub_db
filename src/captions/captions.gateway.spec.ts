import type { Socket } from 'socket.io';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { CaptionsGateway } from './captions.gateway';
import { CAPTURE_DESKS_ROOM } from './captions.service';

function desk(id = 'desk-1') {
  return {
    id,
    disconnected: false,
    data: { user: { role: AccessTier.ADMIN } } as Record<string, unknown>,
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
  };
}

function service() {
  return {
    startRoom: jest.fn(),
    sendAudio: jest.fn(),
    stopRoom: jest.fn().mockResolvedValue(undefined),
    captureSocketLeft: jest.fn(),
    addListener: jest.fn().mockResolvedValue(undefined),
    removeListener: jest.fn().mockResolvedValue(undefined),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('CaptionsGateway capture', () => {
  afterEach(() => jest.useRealTimers());

  it('joins capture desks to their own room on start', async () => {
    const captions = service();
    captions.startRoom.mockResolvedValue({ ok: true });
    const gateway = new CaptionsGateway(captions as never);
    const socket = desk();
    await expect(
      gateway.startCapture(socket as unknown as Socket, { room: 'Hall B' }),
    ).resolves.toEqual({ capturing: 'Hall B', diarise: true });
    expect(socket.join).toHaveBeenCalledWith(CAPTURE_DESKS_ROOM);
  });

  it('takes the room over from its own audio once the other instance lets go', async () => {
    jest.useFakeTimers();
    const captions = service();
    captions.startRoom.mockResolvedValue({
      ok: false,
      holder: 'other',
      retryAfterMs: 12_000,
    });
    const gateway = new CaptionsGateway(captions as never);
    const socket = desk();
    const ack = await gateway.startCapture(socket as unknown as Socket, {
      room: 'Hall B',
    });
    expect(ack).toMatchObject({ error: 'capture-busy', retryAfterMs: 12_000 });

    // audio keeps coming (the desk ignores the reconnect ack); retries are paced
    gateway.audio(socket as unknown as Socket, Buffer.from('a'));
    expect(captions.startRoom).toHaveBeenCalledTimes(1);
    expect(captions.sendAudio).not.toHaveBeenCalled();

    captions.startRoom.mockResolvedValue({ ok: true });
    jest.advanceTimersByTime(2_000);
    gateway.audio(socket as unknown as Socket, Buffer.from('b'));
    await flush();
    expect(captions.startRoom).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenCalledWith('capture:restart', {
      room: 'Hall B',
    });

    gateway.audio(socket as unknown as Socket, Buffer.from('c'));
    expect(captions.sendAudio).toHaveBeenCalledWith('Hall B', Buffer.from('c'));
  });

  it('starts the grace period when a capture desk disconnects', () => {
    const captions = service();
    const gateway = new CaptionsGateway(captions as never);
    const socket = desk();
    socket.data.captureRoom = 'Hall B';
    gateway.handleDisconnect(socket as unknown as Socket);
    expect(captions.captureSocketLeft).toHaveBeenCalledWith('Hall B', 'desk-1');
  });
});

describe('CaptionsGateway listener counts', () => {
  it('counts a language once per socket and uncounts it on leave or disconnect', () => {
    const captions = service();
    const gateway = new CaptionsGateway(captions as never);
    const socket = desk('reader');
    const s = socket as unknown as Socket;

    gateway.join(s, { sessionId: 's1', language: 'ha' });
    gateway.join(s, { sessionId: 's1', language: 'ha' });
    gateway.join(s, { sessionId: 's1', language: 'yo' });
    expect(captions.addListener).toHaveBeenCalledTimes(2);

    gateway.leave(s, { sessionId: 's1', language: 'ha' });
    gateway.leave(s, { sessionId: 's1', language: 'ha' });
    expect(captions.removeListener).toHaveBeenCalledTimes(1);

    gateway.handleDisconnect(s);
    expect(captions.removeListener).toHaveBeenCalledTimes(2);
    expect(captions.removeListener).toHaveBeenLastCalledWith('s1', 'yo');
  });
});
