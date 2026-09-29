import { Job } from 'bullmq';
import { SessionRemindersProcessor } from './session-reminders.processor';
import { Session, SessionStatus } from './entities/session.entity';

/**
 * The reminder job is a claim about a moment. These pin down that it rings
 * only for the moment it was scheduled against, and only for the delegates
 * who saved the session by then.
 */
describe('SessionRemindersProcessor', () => {
  const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);
  const session = (over: Partial<Session> = {}): Session =>
    ({
      id: 's1',
      title: 'Opening Plenary',
      room: 'Main Hall',
      status: SessionStatus.SCHEDULED,
      startsAt: at('09:00'),
      endsAt: at('10:00'),
      ...over,
    }) as Session;

  const build = (found: Session | null, bookmarkers: string[]) => {
    const sessions = { findOneBy: jest.fn().mockResolvedValue(found) };
    const bookmarks = {
      find: jest
        .fn()
        .mockResolvedValue(bookmarkers.map((delegateId) => ({ delegateId }))),
    };
    const notifications = { addBulk: jest.fn().mockResolvedValue([]) };
    const processor = new SessionRemindersProcessor(
      sessions as any,
      bookmarks as any,
      notifications as any,
      // reminders are on unless the console switches them off
      { isMuted: jest.fn().mockResolvedValue(false) } as any,
    );
    const job = {
      data: { sessionId: 's1', startsAt: at('09:00').toISOString() },
    } as Job;
    return { processor, job, notifications };
  };

  it('sends a direct reminder to every delegate who saved the session', async () => {
    const { processor, job, notifications } = build(session(), ['d1', 'd2']);
    await processor.process(job);
    expect(notifications.addBulk).toHaveBeenCalledWith([
      {
        name: 'direct',
        data: {
          delegateId: 'd1',
          title: 'Opening Plenary',
          body: 'Starts in 15 minutes · Main Hall',
          category: 'session-reminder',
          sessionId: 's1',
        },
      },
      {
        name: 'direct',
        data: {
          delegateId: 'd2',
          title: 'Opening Plenary',
          body: 'Starts in 15 minutes · Main Hall',
          category: 'session-reminder',
          sessionId: 's1',
        },
      },
    ]);
  });

  it('stays quiet when the session moved after the job was scheduled', async () => {
    const { processor, job, notifications } = build(
      session({ startsAt: at('09:30') }),
      ['d1'],
    );
    await processor.process(job);
    expect(notifications.addBulk).not.toHaveBeenCalled();
  });

  it('stays quiet when the session is already live, over, or gone', async () => {
    for (const found of [
      session({ status: SessionStatus.LIVE }),
      session({ status: SessionStatus.COMPLETED }),
      null,
    ]) {
      const { processor, job, notifications } = build(found, ['d1']);
      await processor.process(job);
      expect(notifications.addBulk).not.toHaveBeenCalled();
    }
  });

  it('queues nothing when nobody saved it', async () => {
    const { processor, job, notifications } = build(session(), []);
    await processor.process(job);
    expect(notifications.addBulk).not.toHaveBeenCalled();
  });
});
