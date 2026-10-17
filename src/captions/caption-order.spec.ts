import { CaptionsService, effectiveTimeSql, seqOf } from './captions.service';

/**
 * Transcript order is by when a line was said, whichever pass wrote it: live
 * and back-filled rows and newly archived ones carry it in createdAt; a
 * session archived the old way shares one createdAt and adds its offset.
 */
describe('caption order', () => {
  it('is createdAt plus any offset, in SQL as in seqOf', () => {
    expect(effectiveTimeSql('seg')).toBe(
      `("seg"."createdAt" + COALESCE("seg"."offsetMs", 0) * INTERVAL '1 millisecond')`,
    );
    const at = new Date('2026-10-17T09:00:00Z');
    expect(seqOf({ createdAt: at, offsetMs: 2_500 })).toBe(
      at.getTime() + 2_500,
    );
    expect(seqOf({ createdAt: at, offsetMs: null })).toBe(at.getTime());
  });

  function build(rows: unknown[] = []) {
    const qb = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    const segments = { createQueryBuilder: jest.fn(() => qb) };
    const service = new CaptionsService(
      segments as never,
      { openStream: jest.fn() },
      { translate: jest.fn() },
      { add: jest.fn() } as never,
      { add: jest.fn() } as never,
      { findById: jest.fn().mockRejectedValue(new Error('gone')) } as never,
      { emitToRoom: jest.fn() } as never,
      {} as never,
      { appliedFor: jest.fn().mockResolvedValue([]) } as never,
    );
    return { service, qb };
  }

  it('orders the full transcript by that time, oldest first', async () => {
    const { service, qb } = build();
    await service.fullTranscript('s1');
    expect(qb.addSelect).toHaveBeenCalledWith(
      effectiveTimeSql('seg'),
      'effective_at',
    );
    expect(qb.orderBy).toHaveBeenCalledWith('effective_at', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('seg.createdAt', 'ASC');
    expect(qb.limit).not.toHaveBeenCalled();
  });

  it('takes the newest for catch-up and hands them back oldest first', async () => {
    const at = new Date('2026-10-17T09:00:00Z');
    const { service, qb } = build([
      {
        text: 'second',
        createdAt: at,
        offsetMs: 2_000,
        speaker: null,
        mic: null,
      },
      { text: 'first', createdAt: at, offsetMs: 0, speaker: null, mic: null },
    ]);
    const lines = await service.recentCaptions('s1', 'en', 60);
    expect(qb.orderBy).toHaveBeenCalledWith('effective_at', 'DESC');
    expect(qb.limit).toHaveBeenCalledWith(60);
    expect(lines.map((l) => [l.text, l.seq])).toEqual([
      ['first', at.getTime()],
      ['second', at.getTime() + 2_000],
    ]);
  });
});
