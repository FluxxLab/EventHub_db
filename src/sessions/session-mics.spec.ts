import { BadRequestException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/**
 * Naming a session's microphones from the Captions page: each mic once, only
 * the session's own speakers, a label when nobody on the programme holds it,
 * and empty rows dropped.
 */
const SESSION = '11111111-1111-4111-8111-111111111111';
const AMINA = '22222222-2222-4222-8222-222222222221';
const KWAME = '22222222-2222-4222-8222-222222222222';
const STRANGER = '22222222-2222-4222-8222-222222222223';

function setup() {
  const update = jest.fn().mockResolvedValue({});
  const sessions = {
    findOne: jest.fn().mockResolvedValue({
      id: SESSION,
      speakers: [{ id: AMINA }, { id: KWAME }],
    }),
    update,
  };
  const service = new SessionsService(
    sessions as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emitGlobal: jest.fn(), emitToRoom: jest.fn() } as never,
    { get: jest.fn(), set: jest.fn() } as never,
    { announce: jest.fn() } as never,
    { add: jest.fn(), remove: jest.fn() } as never,
    { current: jest.fn() } as never,
  );
  return { service, update };
}

describe('session microphones', () => {
  it('keeps speakers and labels in mic order, dropping empty mics', async () => {
    const { service, update } = setup();
    const saved = await service.setMics(SESSION, [
      { mic: 3, label: '  Audience ' },
      { mic: 1, speakerId: AMINA, label: 'ignored with a speaker' },
      { mic: 2, speakerId: KWAME },
      { mic: 4, speakerId: null, label: '  ' },
    ]);
    expect(saved).toEqual([
      { mic: 1, speakerId: AMINA, label: null },
      { mic: 2, speakerId: KWAME, label: null },
      { mic: 3, speakerId: null, label: 'Audience' },
    ]);
    expect(update).toHaveBeenCalledWith(SESSION, { mics: saved });
  });

  it('refuses a mic listed twice', async () => {
    const { service } = setup();
    await expect(
      service.setMics(SESSION, [
        { mic: 1, speakerId: AMINA },
        { mic: 1, speakerId: KWAME },
      ]),
    ).rejects.toThrow('Mic 1 is listed twice');
  });

  it('refuses a speaker who is not on the session', async () => {
    const { service } = setup();
    await expect(
      service.setMics(SESSION, [{ mic: 1, speakerId: STRANGER }]),
    ).rejects.toThrow(BadRequestException);
  });
});
