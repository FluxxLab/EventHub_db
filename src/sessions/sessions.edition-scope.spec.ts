import { SessionsService } from './sessions.service';
import { SessionStatus } from './entities/session.entity';

/**
 * Sessions are scoped to the summit being shown.
 *
 * Without this, the first GS-27 session created puts two programmes on the
 * same screen, and the failure is quiet: nothing errors, the agenda just
 * gains last year's sessions. These pin down which surfaces filter, which
 * deliberately do not, and that a database with no editions behaves exactly
 * as it did before editions existed.
 */
const GS27 = 'edition-gs27';

function build(currentEditionId: string | null) {
  const captured: { where?: unknown; countWhere: unknown[] } = {
    countWhere: [],
  };

  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
  };

  const sessions = {
    find: jest.fn().mockImplementation((opts: { where?: unknown }) => {
      captured.where = opts?.where;
      return Promise.resolve([]);
    }),
    countBy: jest.fn().mockImplementation((where: unknown) => {
      captured.countWhere.push(where);
      return Promise.resolve(0);
    }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    create: jest.fn().mockImplementation((v: unknown) => v),
    save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
  };

  const editions = {
    current: jest
      .fn()
      .mockResolvedValue(currentEditionId ? { id: currentEditionId } : null),
    isMuted: jest.fn().mockResolvedValue(false),
  };

  const service = new SessionsService(
    sessions as never,
    { findBy: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emitGlobal: jest.fn() } as never,
    { get: jest.fn(), set: jest.fn() } as never,
    { announce: jest.fn().mockResolvedValue({}) } as never,
    { add: jest.fn(), remove: jest.fn() } as never,
    editions as never,
  );

  return { service, sessions, qb, captured };
}

describe('session browse surfaces are scoped to the current edition', () => {
  it('filters the programme', async () => {
    const { service, captured } = build(GS27);
    await service.list({});
    expect(captured.where).toMatchObject({ editionId: GS27 });
  });

  it('keeps the caller filters alongside the edition', async () => {
    const { service, captured } = build(GS27);
    await service.list({ day: 2, status: SessionStatus.LIVE });
    expect(captured.where).toMatchObject({
      editionId: GS27,
      day: 2,
      status: SessionStatus.LIVE,
    });
  });

  it('filters what is live now', async () => {
    const { service, captured } = build(GS27);
    await service.findLiveNow();
    expect(captured.where).toMatchObject({
      editionId: GS27,
      status: SessionStatus.LIVE,
    });
  });

  it('filters the venue board', async () => {
    const { service, captured } = build(GS27);
    await service.board();
    expect(captured.where).toMatchObject({ editionId: GS27 });
  });

  it('filters the console status counts', async () => {
    const { service, captured } = build(GS27);
    await service.statusCounts();
    expect(captured.countWhere).toHaveLength(3);
    for (const where of captured.countWhere) {
      expect(where).toMatchObject({ editionId: GS27 });
    }
  });

  it('filters the live-room lookup, because room names repeat every year', async () => {
    // "Main Hall" exists in every edition. Captions attaching to last year's
    // session would be silent and very hard to explain.
    const { service, qb } = build(GS27);
    await service.findLiveInRoom('Main Hall');
    expect(qb.andWhere).toHaveBeenCalledWith('s.editionId = :editionId', {
      editionId: GS27,
    });
  });

  it('filters search', async () => {
    const { service, qb } = build(GS27);
    await service.searchSessions('gender', 10, true);
    expect(qb.andWhere).toHaveBeenCalledWith('s.editionId = :editionId', {
      editionId: GS27,
    });
  });
});

describe('with no edition configured', () => {
  it('queries everything, exactly as before editions existed', async () => {
    // A database where the migration has not run must not look like a summit
    // with an empty programme.
    const { service, captured } = build(null);
    await service.list({});
    expect(captured.where).not.toHaveProperty('editionId');
  });

  it('adds no edition clause to the live-room lookup', async () => {
    const { service, qb } = build(null);
    await service.findLiveInRoom('Main Hall');
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      's.editionId = :editionId',
      expect.anything(),
    );
  });
});

describe('creating a session', () => {
  const dto = {
    title: 'Opening Plenary',
    description: 'x',
    day: 1,
    startsAt: '2027-09-07T09:00:00+01:00',
    endsAt: '2027-09-07T10:00:00+01:00',
    track: 'economic',
    type: 'plenary',
    room: 'Main Hall',
  } as never;

  it('belongs to the summit now running', async () => {
    const { service, sessions } = build(GS27);
    await service.create(dto, false);
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ editionId: GS27 }),
    );
  });

  it('honours an explicit edition, so next year can be built in advance', async () => {
    const { service, sessions } = build(GS27);
    await service.create(
      { ...(dto as object), editionId: 'edition-gs28' } as never,
      false,
    );
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ editionId: 'edition-gs28' }),
    );
  });

  it('leaves the edition unset when none is current', async () => {
    const { service, sessions } = build(null);
    await service.create(dto, false);
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ editionId: null }),
    );
  });
});
