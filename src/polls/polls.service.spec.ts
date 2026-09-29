import { BadRequestException } from '@nestjs/common';
import { In, Not, Repository } from 'typeorm';
import type Redis from 'ioredis';
import type { RealtimeService } from '../common/realtime/realtime.service';
import { FakeRedis } from '../common/tally/fake-redis.testing';
import {
  LiveTallyService,
  TALLY_EMIT_WINDOW_MS,
} from '../common/tally/live-tally.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { PollVote } from './entities/poll-vote.entity';
import { Poll, PollStatus } from './entities/poll.entity';
import { PollsService } from './polls.service';

/**
 * A poll is one question the whole room answers at once, so the cases that
 * matter are the ones that would make the screen lie: a vote counted twice,
 * a hidden tally leaking to phones, and two polls open at the same time.
 */
const poll = (over: Partial<Poll> = {}): Poll => ({
  id: 'p1',
  editionId: 'gs26',
  sessionId: null,
  question: 'Which track should GS-27 add?',
  options: ['Digital', 'Health', 'GBV'],
  status: PollStatus.OPEN,
  showResults: true,
  createdAt: new Date('2026-09-07T09:00:00Z'),
  openedAt: new Date('2026-09-07T10:00:00Z'),
  closedAt: null,
  ...over,
});

interface TallyRow {
  pollId: string;
  optionIndex: number | string;
  count: string;
}

function build(row: Poll | null = poll()) {
  const tally: { rows: TallyRow[] } = { rows: [] };
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockImplementation(() => Promise.resolve(tally.rows)),
  };
  const polls = {
    findOne: jest.fn().mockResolvedValue(row),
    find: jest.fn().mockResolvedValue(row ? [row] : []),
    create: jest.fn().mockImplementation((v: Partial<Poll>) => v),
    save: jest.fn().mockImplementation((v: Poll) => Promise.resolve(v)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const votes = {
    findOne: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const realtime = { emitToRoom: jest.fn() };
  const redis = new FakeRedis();
  const service = new PollsService(
    polls as unknown as Repository<Poll>,
    votes as unknown as Repository<PollVote>,
    realtime as unknown as RealtimeService,
    new LiveTallyService(redis as unknown as Redis),
  );
  return { service, polls, votes, realtime, tally, qb, redis };
}

const delegate = { id: 'd1', role: AccessTier.STANDARD };
const operator = { id: 'a1', role: AccessTier.SESSION_ADMIN };

describe('PollsService.vote', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('replaces an earlier vote through the unique (poll, delegate) pair', async () => {
    const { service, votes, tally } = build();
    // the standing before this vote, which seeds the live counts
    tally.rows = [
      { pollId: 'p1', optionIndex: 1, count: '3' },
      { pollId: 'p1', optionIndex: 0, count: '1' },
    ];

    const view = await service.vote(delegate, 'p1', 1);

    expect(votes.upsert).toHaveBeenCalledWith(
      { pollId: 'p1', delegateId: 'd1', optionIndex: 1 },
      { conflictPaths: ['pollId', 'delegateId'] },
    );
    expect(view.myVote).toBe(1);
    expect(view.counts).toEqual([1, 4, 0]);
    expect(view.total).toBe(5);
  });

  it('moves the live count when a delegate changes their vote', async () => {
    const { service, votes, tally } = build();
    tally.rows = [{ pollId: 'p1', optionIndex: 0, count: '2' }];
    votes.findOne.mockResolvedValue({ optionIndex: 0 });

    const view = await service.vote(delegate, 'p1', 2);

    expect(view.counts).toEqual([1, 0, 1]);
    expect(view.total).toBe(2);
  });

  it('counts from Postgres only to seed, not on every vote', async () => {
    const { service, votes } = build();
    for (let i = 0; i < 25; i++) {
      await service.vote({ id: `d${i}`, role: AccessTier.STANDARD }, 'p1', 0);
    }
    expect(votes.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it('broadcasts the tally once per window however many votes land', async () => {
    const { service, realtime, tally } = build();
    tally.rows = [{ pollId: 'p1', optionIndex: '2', count: '7' }];

    for (let i = 0; i < 30; i++) {
      await service.vote({ id: `d${i}`, role: AccessTier.STANDARD }, 'p1', 2);
    }
    expect(realtime.emitToRoom).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect(realtime.emitToRoom).toHaveBeenCalledWith('polls', 'poll:results', {
      id: 'p1',
      counts: [0, 0, 37],
      total: 37,
    });
  });

  it('drops a pending broadcast when the poll has closed in the meantime', async () => {
    const { service, realtime, polls } = build();
    await service.vote(delegate, 'p1', 0);
    polls.findOne.mockResolvedValue(poll({ status: PollStatus.CLOSED }));

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).not.toHaveBeenCalled();
  });

  it('keeps a hidden tally off the wire and out of the reply', async () => {
    const { service, realtime, tally } = build(poll({ showResults: false }));
    tally.rows = [{ pollId: 'p1', optionIndex: 0, count: '4' }];

    const view = await service.vote(delegate, 'p1', 0);
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).not.toHaveBeenCalled();
    expect(view.counts).toBeNull();
    // the total is not a result, and the app shows "5 voted"
    expect(view.total).toBe(5);
    expect(view.myVote).toBe(0);
  });

  it('refuses a vote on a poll that is not open', async () => {
    const { service, votes } = build(poll({ status: PollStatus.CLOSED }));
    await expect(service.vote(delegate, 'p1', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(votes.upsert).not.toHaveBeenCalled();
  });

  it('refuses an option the poll does not have', async () => {
    const { service, votes } = build();
    await expect(service.vote(delegate, 'p1', 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(votes.upsert).not.toHaveBeenCalled();
  });
});

describe('PollsService counts visibility', () => {
  const hidden = poll({ showResults: false });

  it('withholds counts from a delegate while an open poll hides results', async () => {
    const { service, tally } = build(hidden);
    tally.rows = [{ pollId: 'p1', optionIndex: 0, count: '2' }];
    const view = await service.current(delegate);
    expect(view?.counts).toBeNull();
    expect(view?.total).toBe(2);
  });

  it('always shows counts to an operator, who is running the poll', async () => {
    const { service, tally } = build(hidden);
    tally.rows = [{ pollId: 'p1', optionIndex: 0, count: '2' }];
    const view = await service.current(operator);
    expect(view?.counts).toEqual([2, 0, 0]);
  });

  it('shows counts to everyone once the poll is closed', async () => {
    const { service, tally } = build(
      poll({
        showResults: false,
        status: PollStatus.CLOSED,
        closedAt: new Date('2026-09-07T10:05:00Z'),
      }),
    );
    tally.rows = [{ pollId: 'p1', optionIndex: 1, count: '9' }];
    const [view] = await service.history(delegate);
    expect(view.counts).toEqual([0, 9, 0]);
    expect(view.closedAt).toBe('2026-09-07T10:05:00.000Z');
  });

  it("fills myVote from the caller's own vote", async () => {
    const { service, votes } = build();
    votes.find.mockResolvedValue([{ pollId: 'p1', optionIndex: 2 }]);
    const view = await service.current(delegate);
    expect(view?.myVote).toBe(2);
    expect(votes.find).toHaveBeenCalledWith({
      where: { delegateId: 'd1', pollId: In(['p1']) },
    });
  });

  it('returns null when nothing is open, which the card has to render', async () => {
    const { service } = build(null);
    expect(await service.current(delegate)).toBeNull();
  });
});

describe('PollsService.open', () => {
  it('closes the other open poll of the edition before opening this one', async () => {
    const draft = poll({ id: 'p2', status: PollStatus.DRAFT, openedAt: null });
    const live = poll({ id: 'p1' });
    const { service, polls, realtime } = build(draft);
    polls.find.mockResolvedValue([live]);

    const view = await service.open(operator, 'p2');

    expect(polls.find).toHaveBeenCalledWith({
      where: { status: PollStatus.OPEN, editionId: 'gs26', id: Not('p2') },
    });
    expect(live.status).toBe(PollStatus.CLOSED);
    expect(live.closedAt).toBeInstanceOf(Date);
    expect(draft.status).toBe(PollStatus.OPEN);
    expect(draft.openedAt).toBeInstanceOf(Date);

    const events = realtime.emitToRoom.mock.calls.map(
      ([room, event, payload]: [string, string, { id: string }]) => [
        room,
        event,
        payload.id,
      ],
    );
    // the old one is announced closed first, so no phone shows two at once
    expect(events).toEqual([
      ['polls', 'poll:closed', 'p1'],
      ['polls', 'poll:opened', 'p2'],
    ]);
    expect(view.status).toBe(PollStatus.OPEN);
    expect(view.myVote).toBeNull();
  });

  it('broadcasts the opened poll with myVote null, since every phone gets the same payload', async () => {
    const draft = poll({ id: 'p2', status: PollStatus.DRAFT, openedAt: null });
    const { service, polls, realtime } = build(draft);
    polls.find.mockResolvedValue([]);

    await service.open(operator, 'p2');

    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'polls',
      'poll:opened',
      expect.objectContaining({
        id: 'p2',
        status: PollStatus.OPEN,
        myVote: null,
        counts: [0, 0, 0],
        total: 0,
      }),
    );
  });

  it('refuses to open a poll that is already open', async () => {
    const { service, polls } = build();
    await expect(service.open(operator, 'p1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(polls.save).not.toHaveBeenCalled();
  });
});

describe('PollsService.update', () => {
  it('edits a draft', async () => {
    const { service } = build(
      poll({ status: PollStatus.DRAFT, openedAt: null }),
    );
    const view = await service.update(operator, 'p1', {
      question: '  Best keynote?  ',
    });
    expect(view.question).toBe('Best keynote?');
  });

  it('refuses to edit a poll people have already voted on', async () => {
    const { service } = build();
    await expect(
      service.update(operator, 'p1', { question: 'Changed' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
