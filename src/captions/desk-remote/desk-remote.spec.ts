import { cleanState } from './desk-remote';
import { DeskRemoteService } from './desk-remote.service';

const state = {
  deskId: 'desk-1a2b',
  name: 'Media desk',
  connected: true,
  channels: [{ value: 'dev1:0', label: 'Behringer 1' }],
  rooms: [{ room: 'Main Hall', source: null, status: null, message: null }],
};

describe('sound desk run remotely', () => {
  it('keeps a desk report, dropping what is not one', () => {
    expect(cleanState(state)).toMatchObject({
      deskId: 'desk-1a2b',
      connected: true,
      rooms: [{ room: 'Main Hall' }],
    });
    expect(cleanState({ ...state, deskId: '../x' })).toBeNull();
    expect(cleanState(null)).toBeNull();
  });

  it('passes a request to the desk, and refuses one for a desk that is off', async () => {
    const redis = { get: jest.fn(), set: jest.fn() };
    const realtime = { emitToRoom: jest.fn() };
    const service = new DeskRemoteService(redis as never, realtime as never);
    redis.get.mockResolvedValueOnce(null);
    await expect(
      service.command('desk-1a2b', 'start', 'Main Hall', undefined, 'u1'),
    ).rejects.toThrow(/not online/);
    redis.get.mockResolvedValue(JSON.stringify(cleanState(state)));
    await expect(
      service.command('desk-1a2b', 'patch', 'Main Hall', 'dev9:3', 'u1'),
    ).rejects.toThrow(/channel/);
    await expect(
      service.command('desk-1a2b', 'start', 'Tamarind A', undefined, 'u1'),
    ).rejects.toThrow(/not on that desk/);
    await service.command('desk-1a2b', 'patch', 'Main Hall', 'dev1:0', 'u1');
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'capture-desk:desk-1a2b',
      'desk:command',
      expect.objectContaining({
        action: 'patch',
        room: 'Main Hall',
        source: 'dev1:0',
        by: 'u1',
      }),
    );
  });
});
