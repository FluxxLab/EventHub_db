import { SessionsService } from './sessions.service';
import { Session, SessionTrack } from './entities/session.entity';

/**
 * The programme audit counts the four things the post-summit report found
 * wrong with GS-26's data. Each count is asserted against a small mixed
 * programme so a change to any one rule shows up as the wrong number, not
 * a missing one.
 */
describe('SessionsService.quality', () => {
  const session = (over: Partial<Session>): Session =>
    ({
      id: 'id',
      track: SessionTrack.HEALTH,
      room: 'Hestel Hall',
      type: 'plenary',
      speakers: [{ id: 'sp1' }],
      ...over,
    }) as Session;

  const build = (rows: Session[], currentEdition: string | null = null) => {
    const sessions = { find: jest.fn().mockResolvedValue(rows) };
    const service = new SessionsService(
      sessions as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        current: jest
          .fn()
          .mockResolvedValue(currentEdition ? { id: currentEdition } : null),
      } as any,
    );
    return { service, sessions };
  };

  const programme = [
    session({ id: 'a', track: SessionTrack.GENERAL, room: 'TBC' }),
    session({
      id: 'b',
      track: SessionTrack.GENERAL,
      room: 'tbc',
      speakers: [],
    }),
    session({ id: 'c', room: 'N/A', type: 'Plenary Session' }),
    session({ id: 'd', type: 'Plenary Session', speakers: [] }),
    session({ id: 'e', type: 'Mystery' }),
    session({ id: 'f', type: 'panel' }),
  ];

  it('counts general-track sessions and names them', async () => {
    const { service } = build(programme);
    const report = await service.quality('ed1');
    expect(report.total).toBe(6);
    expect(report.generalTrack).toEqual({ count: 2, sessionIds: ['a', 'b'] });
  });

  it('groups placeholder rooms by their stored spelling, busiest first', async () => {
    const { service } = build(programme);
    const report = await service.quality('ed1');
    // "TBC" and "tbc" are both placeholders but are two spellings to fix
    expect(report.placeholderRooms).toEqual([
      { room: 'TBC', count: 1 },
      { room: 'tbc', count: 1 },
      { room: 'N/A', count: 1 },
    ]);
  });

  it('lists type spellings the normaliser would change, including unknown ones', async () => {
    const { service } = build(programme);
    const report = await service.quality('ed1');
    expect(report.typeVariants).toEqual([
      { type: 'Plenary Session', count: 2 },
      { type: 'Mystery', count: 1 },
    ]);
  });

  it('counts sessions with nobody on stage', async () => {
    const { service } = build(programme);
    const report = await service.quality('ed1');
    expect(report.withoutSpeakers).toEqual({ count: 2 });
  });

  it('is clean for a clean programme', async () => {
    const { service } = build([session({ id: 'x' })]);
    expect(await service.quality('ed1')).toEqual({
      total: 1,
      generalTrack: { count: 0, sessionIds: [] },
      placeholderRooms: [],
      typeVariants: [],
      withoutSpeakers: { count: 0 },
    });
  });

  it('scopes to the named edition, else the current one, else everything', async () => {
    const named = build(programme, 'current');
    await named.service.quality('ed1');
    expect(named.sessions.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { editionId: 'ed1' } }),
    );

    const current = build(programme, 'current');
    await current.service.quality();
    expect(current.sessions.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { editionId: 'current' } }),
    );

    const none = build(programme, null);
    await none.service.quality();
    expect(none.sessions.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});
