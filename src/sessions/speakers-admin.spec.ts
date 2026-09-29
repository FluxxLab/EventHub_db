import { ConflictException, NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/** Editing and deleting shared speakers: a delete must not silently take anyone off a session. */
function build(speaker: object | null, sessionsOn: { title: string }[] = []) {
  const speakers = {
    findOneBy: jest.fn().mockResolvedValue(speaker),
    save: jest.fn((v: object) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue(sessionsOn),
  };
  const redis = {
    del: jest.fn().mockResolvedValue(1),
    set: jest.fn(),
    get: jest.fn(),
  };
  const service = new SessionsService(
    {} as any,
    speakers as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emitGlobal: jest.fn() } as any,
    redis as any,
    {} as any,
    {} as any,
    { current: jest.fn().mockResolvedValue(null) } as any,
  );
  jest
    .spyOn(service as any, 'invalidateLiveRooms')
    .mockImplementation(() => undefined);
  return { service, speakers };
}

describe('speaker edit and delete', () => {
  it('edits the given fields and clears an emptied role', async () => {
    const { service, speakers } = build({
      id: 's1',
      name: 'Amina',
      role: 'Minister',
      organisation: 'FMoH',
    });
    await service.updateSpeaker('s1', { name: ' Amina Yusuf ', role: '' });
    expect(speakers.save).toHaveBeenCalledWith({
      id: 's1',
      name: 'Amina Yusuf',
      role: null,
      organisation: 'FMoH',
    });
  });

  it('deletes a speaker on no session', async () => {
    const { service, speakers } = build({ id: 's1', name: 'Amina' });
    await service.removeSpeaker('s1');
    expect(speakers.delete).toHaveBeenCalledWith({ id: 's1' });
  });

  it('refuses while they are on sessions, naming a few', async () => {
    const { service, speakers } = build({ id: 's1', name: 'Amina' }, [
      { title: 'Opening' },
      { title: 'Panel' },
      { title: 'Close' },
      { title: 'Extra' },
    ]);
    await expect(service.removeSpeaker('s1')).rejects.toThrow(
      'Amina speaks at 4 sessions ("Opening", "Panel", "Close" and 1 more). Take them off first.',
    );
    expect(speakers.delete).not.toHaveBeenCalled();
    await expect(build(null).service.removeSpeaker('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses with a ConflictException', async () => {
    const { service } = build({ id: 's1', name: 'Amina' }, [
      { title: 'Opening' },
    ]);
    await expect(service.removeSpeaker('s1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
