import { SessionsService } from './sessions.service';
import { SessionStatus } from './entities/session.entity';

/**
 * The caption pipeline asks "what is live in this room" for every fragment,
 * so the answer is cached briefly - and must be forgotten the moment this
 * instance changes a session's status.
 */
function build() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue({ id: 's1', room: 'Main Hall' }),
  };
  const session = {
    id: 's1',
    status: SessionStatus.LIVE,
    title: 'T',
    room: 'Main Hall',
  };
  const sessions = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    findOne: jest.fn().mockResolvedValue(session),
    save: jest.fn((v: unknown) => Promise.resolve(v)),
  };
  const realtime = { emitGlobal: jest.fn(), emitToRoom: jest.fn() };
  const service = new SessionsService(
    sessions as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    realtime as never,
    { get: jest.fn(), set: jest.fn() } as never,
    { announce: jest.fn().mockResolvedValue({}) } as never,
    {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    } as never,
    { current: jest.fn().mockResolvedValue({ id: 'gs26' }) } as never,
  );
  return { service, qb, realtime };
}

describe('findLiveInRoom cache', () => {
  afterEach(() => jest.useRealTimers());

  it('queries once for a burst of fragments, loosely keyed by room', async () => {
    const { service, qb } = build();
    await Promise.all([
      service.findLiveInRoom('Main Hall'),
      service.findLiveInRoom('main hall '),
      service.findLiveInRoom('Main Hall'),
    ]);
    expect(qb.getOne).toHaveBeenCalledTimes(1);
  });

  it('asks again after the TTL', async () => {
    jest.useFakeTimers();
    const { service, qb } = build();
    await service.findLiveInRoom('Main Hall');
    jest.advanceTimersByTime(5_001);
    await service.findLiveInRoom('Main Hall');
    expect(qb.getOne).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failed lookup', async () => {
    const { service, qb } = build();
    qb.getOne.mockRejectedValueOnce(new Error('db down'));
    await expect(service.findLiveInRoom('Main Hall')).rejects.toThrow(
      'db down',
    );
    await service.findLiveInRoom('Main Hall');
    expect(qb.getOne).toHaveBeenCalledTimes(2);
  });

  it('is invalidated when this instance changes a session status, which is emitted once', async () => {
    const { service, qb, realtime } = build();
    await service.findLiveInRoom('Main Hall');
    jest.spyOn(service, 'findById').mockResolvedValue({
      id: 's1',
      status: SessionStatus.LIVE,
      title: 'T',
      room: 'Main Hall',
    } as never);
    await service.setStatus('s1', SessionStatus.COMPLETED);
    await service.findLiveInRoom('Main Hall');
    expect(qb.getOne).toHaveBeenCalledTimes(2);

    const statusEmits = [
      ...realtime.emitGlobal.mock.calls,
      ...realtime.emitToRoom.mock.calls,
    ].filter((call) => call.includes('session:status'));
    expect(statusEmits).toHaveLength(1);
    expect(realtime.emitGlobal).toHaveBeenCalledWith(
      'session:status',
      expect.objectContaining({
        sessionId: 's1',
        status: SessionStatus.COMPLETED,
      }),
    );
  });
});
