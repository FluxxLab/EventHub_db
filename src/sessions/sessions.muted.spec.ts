import { SessionsService } from './sessions.service';
import { SessionStatus } from './entities/session.entity';

/**
 * The off switch actually switches off. One case per behaviour, because a
 * mute that silences "schedule change" but not "now live" is a bug nobody
 * notices until three thousand phones buzz.
 */
function build(mutedKinds: string[]) {
  const announce = jest.fn().mockResolvedValue({});
  const editions = {
    current: jest.fn().mockResolvedValue({ id: 'gs27' }),
    isMuted: jest
      .fn()
      .mockImplementation((kind: string) =>
        Promise.resolve(mutedKinds.includes(kind)),
      ),
  };
  const session = {
    id: 's1',
    title: 'Opening Plenary',
    room: 'Main Hall',
    status: SessionStatus.SCHEDULED,
    startsAt: new Date('2027-09-07T09:00:00+01:00'),
    endsAt: new Date('2027-09-07T10:00:00+01:00'),
    speakers: [],
  };
  const sessions = {
    findOne: jest.fn().mockResolvedValue(session),
    save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
    create: jest.fn().mockImplementation((v: unknown) => v),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };
  const service = new SessionsService(
    sessions as never,
    { findBy: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emitGlobal: jest.fn(), emitToRoom: jest.fn() } as never,
    { get: jest.fn(), set: jest.fn() } as never,
    { announce } as never,
    // cancelReminder chains .catch on the queue's promise
    {
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    } as never,
    editions as never,
  );
  return { service, announce };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('automatic session pushes respect the edition mute list', () => {
  it('still announces when nothing is muted', async () => {
    const { service, announce } = build([]);
    await service.setStatus('s1', SessionStatus.LIVE);
    await flush();
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'session-live' }),
    );
  });

  it('says nothing when "now live" is muted', async () => {
    const { service, announce } = build(['session-live']);
    await service.setStatus('s1', SessionStatus.LIVE);
    await flush();
    expect(announce).not.toHaveBeenCalled();
  });

  it('mutes only the kind that was switched off', async () => {
    // "schedule change" off must not silence "now live"
    const { service, announce } = build(['session-updated']);
    await service.setStatus('s1', SessionStatus.LIVE);
    await flush();
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
