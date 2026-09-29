import { ConflictException, NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AudienceSegment } from '../notifications/entities/notification.entity';

/**
 * One room holds one session at a time. Clearing the room is the one edit
 * that writes rows the operator did not open, and a wrong rule either leaves
 * two sessions on top of each other or drags half a day for nothing. These
 * pin down what moves, how far, and what is refused.
 */
describe('SessionsService.update room clearing', () => {
  const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);
  const iso = (hhmm: string) => `2026-09-08T${hhmm}:00+01:00`;

  const session = (over: Partial<Session>): Session =>
    ({
      id: over.id ?? 'edited',
      title: over.id ?? 'edited',
      day: 1,
      room: 'Hestel',
      status: SessionStatus.SCHEDULED,
      speakers: [],
      ...over,
    }) as Session;

  const build = (edited: Session, others: Session[]) => {
    const saved: Session[][] = [];
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            others
              .filter((s) => s.status !== SessionStatus.COMPLETED)
              .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
          ),
        ),
    };
    const sessions = {
      findOne: jest.fn().mockResolvedValue(edited),
      save: jest.fn().mockImplementation((v: Session | Session[]) => {
        if (Array.isArray(v)) saved.push(v);
        return Promise.resolve(v);
      }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const realtime = {
      emitGlobal: jest.fn(),
      emit: jest.fn(),
      emitToRoom: jest.fn(),
    };
    const notifications = { announce: jest.fn().mockResolvedValue({}) };
    const reminders = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(1),
    };
    const service = new SessionsService(
      sessions as any,
      { findBy: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      realtime as any,
      {} as any,
      notifications as any,
      reminders as any,
      // no current edition: browse queries stay unscoped, which is what these
      // cases are about
      {
        current: jest.fn().mockResolvedValue(null),
        isMuted: jest.fn().mockResolvedValue(false),
      } as any,
    );
    return { service, saved, realtime, sessions, notifications };
  };

  it('pushes a later session just far enough to clear the edit', async () => {
    // Pre Registration 12:00-13:00 edited to end 13:30; Hestel 12:25-13:05
    // was already on top of it. Hestel lands at 13:30, keeping its 40 min.
    const edited = session({ startsAt: at('12:00'), endsAt: at('13:00') });
    const next = session({
      id: 'next',
      startsAt: at('12:25'),
      endsAt: at('13:05'),
    });
    const { service, saved, realtime } = build(edited, [next]);

    await service.update('edited', {
      endsAt: iso('13:30'),
      shiftFollowing: true,
    });

    expect(saved).toEqual([[next]]);
    expect(next.startsAt).toEqual(at('13:30'));
    expect(next.endsAt).toEqual(at('14:10'));
    expect(realtime.emitGlobal).toHaveBeenCalledWith(
      'sessions:shifted',
      expect.objectContaining({
        deltaMinutes: 65,
        sessionIds: ['edited', 'next'],
      }),
    );
  });

  it('cascades: a pushed session pushes the one it lands on', async () => {
    const edited = session({ startsAt: at('09:00'), endsAt: at('10:00') });
    const b = session({ id: 'b', startsAt: at('10:00'), endsAt: at('11:00') });
    const c = session({ id: 'c', startsAt: at('11:00'), endsAt: at('12:00') });
    const d = session({ id: 'd', startsAt: at('13:00'), endsAt: at('14:00') });
    const { service, saved } = build(edited, [b, c, d]);

    // delayed by half an hour, length kept
    await service.update('edited', {
      startsAt: iso('09:30'),
      endsAt: iso('10:30'),
      shiftFollowing: true,
    });

    expect(saved[0].map((s) => s.id)).toEqual(['b', 'c']);
    expect(b.startsAt).toEqual(at('10:30'));
    expect(c.startsAt).toEqual(at('11:30'));
    expect(c.endsAt).toEqual(at('12:30'));
    // the gap before d absorbs the delay; d stays put
    expect(d.startsAt).toEqual(at('13:00'));
  });

  it('leaves the room alone when nothing overlaps', async () => {
    const edited = session({ startsAt: at('09:00'), endsAt: at('10:00') });
    const next = session({
      id: 'next',
      startsAt: at('10:30'),
      endsAt: at('11:00'),
    });
    const { service, saved, realtime } = build(edited, [next]);

    await service.update('edited', {
      endsAt: iso('10:15'),
      shiftFollowing: true,
    });

    expect(saved).toHaveLength(0);
    expect(next.startsAt).toEqual(at('10:30'));
    expect(realtime.emitGlobal).not.toHaveBeenCalledWith(
      'sessions:shifted',
      expect.anything(),
    );
    // the plain edit is still announced
    expect(realtime.emitGlobal).toHaveBeenCalledWith('session:updated', {
      sessionId: 'edited',
    });
  });

  it('pushes by default when the flag is not sent', async () => {
    const edited = session({ startsAt: at('09:00'), endsAt: at('10:00') });
    const next = session({
      id: 'next',
      startsAt: at('10:00'),
      endsAt: at('11:00'),
    });
    const { service, saved } = build(edited, [next]);

    await service.update('edited', { endsAt: iso('10:15') });

    expect(saved).toEqual([[next]]);
    expect(next.startsAt).toEqual(at('10:15'));
  });

  it('refuses a collision when told not to push, and writes nothing', async () => {
    const edited = session({ startsAt: at('09:00'), endsAt: at('10:00') });
    const next = session({
      id: 'next',
      startsAt: at('10:00'),
      endsAt: at('11:00'),
    });
    const { service, sessions } = build(edited, [next]);

    await expect(
      service.update('edited', { endsAt: iso('10:15'), shiftFollowing: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.save).not.toHaveBeenCalled();
    expect(next.startsAt).toEqual(at('10:00'));
  });

  it('refuses an edit that starts inside the session before it', async () => {
    const edited = session({ startsAt: at('10:00'), endsAt: at('11:00') });
    const prev = session({
      id: 'prev',
      startsAt: at('09:00'),
      endsAt: at('10:00'),
    });
    const { service, sessions } = build(edited, [prev]);

    await expect(
      service.update('edited', {
        startsAt: iso('09:45'),
        shiftFollowing: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it('does not touch the room when only the title changed', async () => {
    const edited = session({ startsAt: at('09:00'), endsAt: at('10:00') });
    const next = session({
      id: 'next',
      startsAt: at('09:30'),
      endsAt: at('10:30'),
    }); // already overlapping, but this edit is not about time
    const { service, sessions } = build(edited, [next]);

    await service.update('edited', { title: 'renamed' });

    expect(sessions.createQueryBuilder).not.toHaveBeenCalled();
    expect(sessions.save).toHaveBeenCalledTimes(1);
  });
});

/**
 * The live push is the one thing a delegate with the app closed gets from a
 * status change. It must fire exactly on the transition to live - not on
 * every save while live, and not when a session ends.
 */
describe('SessionsService.setStatus live push', () => {
  const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);
  const build = (status: SessionStatus) => {
    const session = {
      id: 's1',
      title: 'Opening Plenary',
      room: 'Main Hall',
      day: 1,
      status,
      startsAt: at('09:00'),
      endsAt: at('10:00'),
      speakers: [],
    } as unknown as Session;
    const sessions = {
      findOne: jest.fn().mockResolvedValue(session),
      save: jest.fn().mockImplementation((v: Session) => Promise.resolve(v)),
    };
    const realtime = {
      emitGlobal: jest.fn(),
      emit: jest.fn(),
      emitToRoom: jest.fn(),
    };
    const notifications = { announce: jest.fn().mockResolvedValue({}) };
    const reminders = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(1),
    };
    const service = new SessionsService(
      sessions as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      realtime as any,
      {} as any,
      notifications as any,
      reminders as any,
      // no current edition: browse queries stay unscoped, which is what these
      // cases are about
      {
        current: jest.fn().mockResolvedValue(null),
        isMuted: jest.fn().mockResolvedValue(false),
      } as any,
    );
    return { service, notifications };
  };

  it('announces to everyone when a session goes live', async () => {
    const { service, notifications } = build(SessionStatus.SCHEDULED);
    await service.setStatus('s1', SessionStatus.LIVE);
    expect(notifications.announce).toHaveBeenCalledTimes(1);
    expect(notifications.announce).toHaveBeenCalledWith({
      title: 'Opening Plenary',
      body: 'Now live in Main Hall',
      segment: AudienceSegment.ALL,
      category: 'session-live',
      // so tapping the notification opens the session it announces
      sessionId: 's1',
    });
  });

  it('does not announce again when a live session is set live', async () => {
    const { service, notifications } = build(SessionStatus.LIVE);
    await service.setStatus('s1', SessionStatus.LIVE);
    expect(notifications.announce).not.toHaveBeenCalled();
  });

  it('does not announce when a session completes', async () => {
    const { service, notifications } = build(SessionStatus.LIVE);
    await service.setStatus('s1', SessionStatus.COMPLETED);
    expect(notifications.announce).not.toHaveBeenCalled();
  });

  it('keeps the status change when the push cannot be queued', async () => {
    const { service, notifications } = build(SessionStatus.SCHEDULED);
    notifications.announce.mockRejectedValue(new Error('redis down'));
    const saved = await service.setStatus('s1', SessionStatus.LIVE);
    expect(saved.status).toBe(SessionStatus.LIVE);
  });
});

/**
 * Every programme change is announced to every delegate. These pin down
 * which edits buzz, which do not, and that an agenda import is one push and
 * not sixty.
 */
describe('SessionsService programme notifications', () => {
  const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);
  const iso = (hhmm: string) => `2026-09-08T${hhmm}:00+01:00`;
  const row = (over: Partial<Session>): Session =>
    ({
      id: 'edited',
      title: 'Opening Plenary',
      room: 'Main Hall',
      day: 1,
      status: SessionStatus.SCHEDULED,
      startsAt: at('09:00'),
      endsAt: at('10:00'),
      speakers: [],
      ...over,
    }) as Session;

  const build = (
    edited: Session,
    others: Session[] = [],
    catalog?: unknown,
  ) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(others),
    };
    const sessions = {
      findOne: jest.fn().mockResolvedValue(edited),
      create: jest.fn().mockImplementation((v: Partial<Session>) => ({ ...v })),
      save: jest
        .fn()
        .mockImplementation((v: Session | Session[]) =>
          Promise.resolve(
            Array.isArray(v) ? v : { ...row({}), ...v, id: v.id ?? 'new' },
          ),
        ),
      delete: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      query: jest.fn().mockResolvedValue([{}]),
    };
    const counting = {
      countBy: jest.fn().mockResolvedValue(0),
      delete: jest.fn(),
    };
    const realtime = {
      emitGlobal: jest.fn(),
      emit: jest.fn(),
      emitToRoom: jest.fn(),
    };
    const notifications = { announce: jest.fn().mockResolvedValue({}) };
    const reminders = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(1),
    };
    const redis = { set: jest.fn(), get: jest.fn() };
    const service = new SessionsService(
      sessions as any,
      { findBy: jest.fn().mockResolvedValue([]) } as any,
      counting as any,
      counting as any,
      counting as any,
      counting as any,
      realtime as any,
      redis as any,
      notifications as any,
      reminders as any,
      // no current edition: browse queries stay unscoped, which is what these
      // cases are about
      {
        current: jest.fn().mockResolvedValue(null),
        isMuted: jest.fn().mockResolvedValue(false),
      } as any,
      undefined,
      catalog as any,
    );
    return { service, notifications, sessions };
  };

  const dto = {
    title: 'Opening Plenary',
    description: '',
    day: 1,
    startsAt: iso('09:00'),
    endsAt: iso('10:00'),
    room: 'Main Hall',
    track: 'general',
    type: 'Plenary',
  } as any;

  it("checks the track against the session's edition before saving", async () => {
    const catalog = {
      assertSessionTrack: jest
        .fn()
        .mockRejectedValue(new Error(`"Health" is not one of GS-27's tracks`)),
    };
    const { service, sessions, notifications } = build(row({}), [], catalog);
    await expect(
      service.create({ ...dto, track: 'health', editionId: 'gs27' }),
    ).rejects.toThrow("is not one of GS-27's tracks");
    expect(catalog.assertSessionTrack).toHaveBeenCalledWith('health', 'gs27');
    expect(sessions.save).not.toHaveBeenCalled();
    expect(notifications.announce).not.toHaveBeenCalled();
  });

  it('announces a new session with its slot in summit time', async () => {
    const { service, notifications } = build(row({}));
    await service.create(dto);
    expect(notifications.announce).toHaveBeenCalledTimes(1);
    expect(notifications.announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Opening Plenary',
        body: 'Added to the programme · Tue 8 Sept 09:00–10:00 · Main Hall',
        segment: AudienceSegment.ALL,
        category: 'session-created',
      }),
    );
  });

  it('sends one summary for a bulk import, not one per row', async () => {
    const { service, notifications } = build(row({}));
    await service.createBulk([dto, dto, dto]);
    expect(notifications.announce).toHaveBeenCalledTimes(1);
    expect(notifications.announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Programme updated',
        body: '3 sessions added. Check your agenda.',
      }),
    );
  });

  it('announces a time change for the edited session and each one it pushed', async () => {
    const next = row({
      id: 'next',
      title: 'Panel',
      startsAt: at('10:00'),
      endsAt: at('11:00'),
    });
    const { service, notifications } = build(row({}), [next]);
    await service.update('edited', { endsAt: iso('10:30') });
    const bodies = notifications.announce.mock.calls.map((c) => c[0].body);
    expect(bodies).toEqual([
      'Schedule change · Tue 8 Sept 09:00–10:30 · Main Hall',
      'Schedule change · Tue 8 Sept 10:30–11:30 · Main Hall',
    ]);
  });

  it('stays quiet for a title-only edit', async () => {
    const { service, notifications } = build(row({}));
    await service.update('edited', { title: 'Renamed' });
    expect(notifications.announce).not.toHaveBeenCalled();
  });

  it('stays quiet on a deletion', async () => {
    const { service, notifications } = build(row({}));
    await service.remove('edited');
    expect(notifications.announce).not.toHaveBeenCalled();
  });

  it('bulk delete removes what it can and names what it refused', async () => {
    const { service } = build(row({}));
    const removeSpy = jest
      .spyOn(service, 'remove')
      .mockImplementation(async (id: string) => {
        if (id === 'busy')
          throw new ConflictException('"Busy" has 3 comment(s).');
        if (id === 'gone') throw new NotFoundException();
      });
    await expect(
      service.removeMany(['a', 'busy', 'gone', 'b']),
    ).rejects.toThrow('1 of 4 not deleted. "Busy" has 3 comment(s).');
    expect(removeSpy.mock.calls.map((c) => c[0])).toEqual([
      'a',
      'busy',
      'gone',
      'b',
    ]);
  });

  it('bulk delete with force passes force through and resolves', async () => {
    const { service } = build(row({}));
    const removeSpy = jest.spyOn(service, 'remove').mockResolvedValue();
    await expect(service.removeMany(['a', 'b'], true)).resolves.toBeUndefined();
    expect(removeSpy).toHaveBeenCalledWith('a', true);
    expect(removeSpy).toHaveBeenCalledWith('b', true);
  });

  it('announces the speaker reveal, but not hiding them again', async () => {
    const { service, notifications } = build(row({}));
    await service.setSpeakersRevealed(true);
    await service.setSpeakersRevealed(false);
    expect(notifications.announce).toHaveBeenCalledTimes(1);
    expect(notifications.announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Speakers announced',
        category: 'speakers-revealed',
      }),
    );
  });
});

/**
 * The saved-session reminder is a delayed job per session. These pin down
 * when it is (re)scheduled, the lead time, and when it is withdrawn.
 */
describe('SessionsService saved-session reminders', () => {
  const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);
  const iso = (hhmm: string) => `2026-09-08T${hhmm}:00+01:00`;
  // the clock reads 08:00 Abuja on the day
  const NOW = at('08:00').getTime();
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  const row = (over: Partial<Session>): Session =>
    ({
      id: 'edited',
      title: 'Opening Plenary',
      room: 'Main Hall',
      day: 1,
      status: SessionStatus.SCHEDULED,
      startsAt: at('09:00'),
      endsAt: at('10:00'),
      speakers: [],
      ...over,
    }) as Session;

  const build = (edited: Session, others: Session[] = []) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(others),
    };
    const sessions = {
      findOne: jest.fn().mockResolvedValue(edited),
      find: jest.fn().mockResolvedValue(others),
      create: jest.fn().mockImplementation((v: Partial<Session>) => ({ ...v })),
      save: jest
        .fn()
        .mockImplementation((v: Session | Session[]) =>
          Promise.resolve(
            Array.isArray(v) ? v : { ...row({}), ...v, id: v.id ?? 'new' },
          ),
        ),
      delete: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      query: jest.fn().mockResolvedValue([{}]),
    };
    const counting = {
      countBy: jest.fn().mockResolvedValue(0),
      delete: jest.fn(),
    };
    const realtime = {
      emitGlobal: jest.fn(),
      emit: jest.fn(),
      emitToRoom: jest.fn(),
    };
    const reminders = {
      add: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(1),
    };
    const service = new SessionsService(
      sessions as any,
      { findBy: jest.fn().mockResolvedValue([]) } as any,
      counting as any,
      counting as any,
      counting as any,
      counting as any,
      realtime as any,
      { set: jest.fn(), get: jest.fn() } as any,
      { announce: jest.fn().mockResolvedValue({}) } as any,
      reminders as any,
      // no current edition: browse queries stay unscoped, which is what these
      // cases are about
      {
        current: jest.fn().mockResolvedValue(null),
        isMuted: jest.fn().mockResolvedValue(false),
      } as any,
    );
    return { service, reminders, sessions };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('schedules a job 15 minutes before a new session, keyed by session id', async () => {
    const { service, reminders } = build(row({}));
    await service.create({
      title: 'Opening Plenary',
      description: '',
      day: 1,
      room: 'Main Hall',
      startsAt: iso('09:00'),
      endsAt: iso('10:00'),
      track: 'general',
      type: 'Plenary',
    });
    await flush();
    expect(reminders.remove).toHaveBeenCalledWith('reminder-new');
    expect(reminders.add).toHaveBeenCalledWith(
      'remind',
      { sessionId: 'new', startsAt: at('09:00').toISOString() },
      expect.objectContaining({ jobId: 'reminder-new', delay: 45 * 60_000 }),
    );
  });

  it('reschedules the edited session and each one it pushed', async () => {
    const next = row({
      id: 'next',
      title: 'Panel',
      startsAt: at('10:00'),
      endsAt: at('11:00'),
    });
    const { service, reminders } = build(row({}), [next]);
    await service.update('edited', { endsAt: iso('10:30') });
    await flush();
    const ids = reminders.add.mock.calls.map((c) => c[2].jobId);
    expect(ids).toEqual(['reminder-edited', 'reminder-next']);
    expect(reminders.add.mock.calls[1][1].startsAt).toBe(
      at('10:30').toISOString(),
    );
  });

  it('does not schedule when the start is already inside the lead time', async () => {
    const { service, reminders } = build(row({}));
    await service.update('edited', {
      startsAt: iso('08:10'),
      endsAt: iso('09:10'),
    });
    await flush();
    expect(reminders.remove).toHaveBeenCalledWith('reminder-edited');
    expect(reminders.add).not.toHaveBeenCalled();
  });

  it('withdraws the reminder when a session goes live or is deleted', async () => {
    const { service, reminders } = build(row({}));
    await service.setStatus('edited', SessionStatus.LIVE);
    await service.remove('edited');
    await flush();
    expect(reminders.remove).toHaveBeenCalledTimes(2);
    expect(reminders.add).not.toHaveBeenCalled();
  });

  it('re-issues jobs for every upcoming session on boot', async () => {
    const upcoming = [
      row({ id: 'a' }),
      row({ id: 'b', startsAt: at('11:00'), endsAt: at('12:00') }),
    ];
    const { service, reminders, sessions } = build(row({}), upcoming);
    await service.onApplicationBootstrap();
    expect(sessions.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SessionStatus.SCHEDULED }),
      }),
    );
    expect(reminders.add.mock.calls.map((c) => c[2].jobId)).toEqual([
      'reminder-a',
      'reminder-b',
    ]);
  });
});
