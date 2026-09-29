import type { Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import type { SessionAttendance } from '../sessions/entities/attendance.entity';
import type { SessionBookmark } from '../sessions/entities/bookmark.entity';
import type { Session } from '../sessions/entities/session.entity';
import type { SessionsService } from '../sessions/sessions.service';
import { SessionFeedback } from './entities/session-feedback.entity';
import { FeedbackService, summariseFeedback } from './feedback.service';

/**
 * The numbers the organisers read after the summit come from here, so the
 * cases that matter are one voice per delegate, the arithmetic behind the
 * average, and the prompt reaching each attendee exactly once.
 */
const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);

const row = (over: Partial<SessionFeedback> = {}): SessionFeedback => ({
  id: 'f1',
  sessionId: 's1',
  delegateId: 'd1',
  rating: 4,
  comment: null,
  createdAt: at('10:00'),
  updatedAt: at('10:00'),
  ...over,
});

function build(
  opts: {
    existing?: SessionFeedback | null;
    bookmarked?: string[];
    attended?: string[];
  } = {},
) {
  const feedback = {
    findOne: jest.fn().mockResolvedValue(opts.existing ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockImplementation((v: Partial<SessionFeedback>) =>
        row({ ...v, id: 'created' }),
      ),
    save: jest
      .fn()
      .mockImplementation((v: SessionFeedback) => Promise.resolve(v)),
    createQueryBuilder: jest.fn(),
  };
  const bookmarks = {
    find: jest
      .fn()
      .mockResolvedValue(
        (opts.bookmarked ?? []).map((delegateId) => ({ delegateId })),
      ),
  };
  const attendance = {
    find: jest
      .fn()
      .mockResolvedValue(
        (opts.attended ?? []).map((delegateId) => ({ delegateId })),
      ),
  };
  const sessionRows = { find: jest.fn().mockResolvedValue([]) };
  const sessions = {
    findById: jest
      .fn()
      .mockResolvedValue({ id: 's1', title: 'Opening Plenary' }),
  };
  const queue = { addBulk: jest.fn().mockResolvedValue([]) };
  const service = new FeedbackService(
    feedback as unknown as Repository<SessionFeedback>,
    bookmarks as unknown as Repository<SessionBookmark>,
    attendance as unknown as Repository<SessionAttendance>,
    sessionRows as unknown as Repository<Session>,
    sessions as unknown as SessionsService,
    queue as unknown as Queue,
  );
  return { service, feedback, bookmarks, attendance, sessionRows, queue };
}

describe('FeedbackService.submit', () => {
  it('creates a row the first time a delegate rates a session', async () => {
    const { service, feedback } = build();
    const view = await service.submit('s1', 'd1', {
      rating: 5,
      comment: ' Superb ',
    });
    expect(feedback.create).toHaveBeenCalledWith({
      sessionId: 's1',
      delegateId: 'd1',
      rating: 5,
      comment: 'Superb',
    });
    expect(view).toEqual({
      sessionId: 's1',
      rating: 5,
      comment: 'Superb',
      createdAt: at('10:00').toISOString(),
    });
  });

  it('replaces the earlier rating rather than adding a second one', async () => {
    const existing = row({ rating: 2, comment: 'Meh' });
    const { service, feedback } = build({ existing });
    const view = await service.submit('s1', 'd1', { rating: 4 });
    expect(feedback.create).not.toHaveBeenCalled();
    expect(feedback.save).toHaveBeenCalledWith(existing);
    expect(existing.rating).toBe(4);
    // a resubmission without a comment clears the old one: the form sends
    // what the delegate now sees, not a diff
    expect(view.comment).toBeNull();
  });

  it('stores an empty comment as null', async () => {
    const { service, feedback } = build();
    await service.submit('s1', 'd1', { rating: 3, comment: '   ' });
    expect(feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({ comment: null }),
    );
  });
});

describe('FeedbackService.mine', () => {
  it('is null when the delegate has not rated, which the app renders as the prompt', async () => {
    const { service } = build();
    expect(await service.mine('s1', 'd1')).toBeNull();
  });
});

describe('summariseFeedback', () => {
  it('counts, averages to two decimals and buckets every star', () => {
    const summary = summariseFeedback([
      row({ rating: 5 }),
      row({ rating: 4 }),
      row({ rating: 4 }),
      row({ rating: 1 }),
    ]);
    expect(summary.count).toBe(4);
    expect(summary.average).toBe(3.5);
    expect(summary.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 2, 5: 1 });
  });

  it('rounds rather than truncating the average', () => {
    expect(
      summariseFeedback([
        row({ rating: 5 }),
        row({ rating: 5 }),
        row({ rating: 4 }),
      ]).average,
    ).toBe(4.67);
  });

  it('is all zeros for a session nobody rated', () => {
    expect(summariseFeedback([])).toEqual({
      count: 0,
      average: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      comments: [],
    });
  });

  it('lists only non-empty comments, newest first', () => {
    const summary = summariseFeedback([
      row({ rating: 3, comment: 'Ran long', createdAt: at('10:00') }),
      row({ rating: 5, comment: '   ', createdAt: at('10:30') }),
      row({ rating: 4, comment: null, createdAt: at('10:40') }),
      row({ rating: 5, comment: 'Brilliant', createdAt: at('11:00') }),
    ]);
    expect(summary.comments).toEqual([
      { rating: 5, comment: 'Brilliant', createdAt: at('11:00').toISOString() },
      { rating: 3, comment: 'Ran long', createdAt: at('10:00').toISOString() },
    ]);
  });
});

describe('FeedbackService.editionSummary', () => {
  it('ranks rated sessions by average and puts unrated ones last', async () => {
    const { service, feedback, sessionRows } = build();
    sessionRows.find.mockResolvedValue([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { sessionId: 'a', count: '3', average: '3.6666' },
        { sessionId: 'c', count: '10', average: '4.9' },
      ]),
    };
    feedback.createQueryBuilder.mockReturnValue(qb);
    const rows = await service.editionSummary('e1');
    expect(rows).toEqual([
      { sessionId: 'c', title: 'C', count: 10, average: 4.9 },
      { sessionId: 'a', title: 'A', count: 3, average: 3.67 },
      { sessionId: 'b', title: 'B', count: 0, average: null },
    ]);
  });

  it('skips the aggregate when the edition has no sessions', async () => {
    const { service, feedback } = build();
    expect(await service.editionSummary('e1')).toEqual([]);
    expect(feedback.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('FeedbackService.promptForSession', () => {
  it('prompts bookmarkers and attendees once each', async () => {
    const { service, queue } = build({
      bookmarked: ['d1', 'd2'],
      attended: ['d2', 'd3'],
    });
    const notified = await service.promptForSession('s1');
    expect(notified).toBe(3);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    const jobs = queue.addBulk.mock.calls[0][0] as {
      name: string;
      data: { delegateId: string };
    }[];
    expect(jobs.map((j) => j.data.delegateId).sort()).toEqual([
      'd1',
      'd2',
      'd3',
    ]);
    expect(jobs[0]).toEqual({
      name: 'direct',
      data: {
        delegateId: 'd1',
        title: 'How was Opening Plenary?',
        body: 'One tap to rate it.',
        category: 'session-feedback',
        sessionId: 's1',
      },
    });
  });

  it('queues nothing when nobody saved or attended the session', async () => {
    const { service, queue } = build();
    expect(await service.promptForSession('s1')).toBe(0);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });
});
