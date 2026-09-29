import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import type Redis from 'ioredis';
import type { RealtimeService } from '../common/realtime/realtime.service';
import { FakeRedis } from '../common/tally/fake-redis.testing';
import {
  LiveTallyService,
  TALLY_EMIT_WINDOW_MS,
} from '../common/tally/live-tally.service';
import type { DelegatesService } from '../delegate/delegates.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { SessionsService } from '../sessions/sessions.service';
import { QuestionVote } from './entities/question-vote.entity';
import {
  QuestionStatus,
  SessionQuestion,
} from './entities/session-question.entity';
import {
  MAX_OPEN_QUESTIONS_PER_DELEGATE,
  QuestionsService,
  rankQuestions,
} from './questions.service';

/**
 * The queue is what the moderator reads from the stage, so the cases that
 * matter are the order it comes out in, the cap that stops one delegate
 * filling it, and the upvote counter staying honest under a toggle.
 */
const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00+01:00`);

const question = (over: Partial<SessionQuestion> = {}): SessionQuestion => ({
  id: 'q1',
  sessionId: 's1',
  delegateId: 'd1',
  text: 'How is the fund allocated?',
  status: QuestionStatus.OPEN,
  upvotes: 0,
  createdAt: at('09:00'),
  answeredAt: null,
  ...over,
});

const delegate: AuthUser = {
  id: 'd1',
  role: AccessTier.STANDARD,
  jti: 'j',
  exp: 0,
};
const admin: AuthUser = { ...delegate, id: 'staff', role: AccessTier.ADMIN };

function build(found: SessionQuestion | null = question()) {
  const manager = {
    getRepository: jest.fn(),
    increment: jest.fn().mockResolvedValue(undefined),
    decrement: jest.fn().mockResolvedValue(undefined),
    findOneOrFail: jest.fn().mockResolvedValue(found),
  };
  const txVotes = {
    findOne: jest.fn().mockResolvedValue(null),
    insert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const txQuestions = { delete: jest.fn().mockResolvedValue(undefined) };
  manager.getRepository.mockImplementation((entity: unknown) =>
    entity === QuestionVote ? txVotes : txQuestions,
  );
  const questions = {
    findOne: jest.fn().mockResolvedValue(found),
    find: jest.fn().mockResolvedValue(found ? [found] : []),
    countBy: jest.fn().mockResolvedValue(0),
    create: jest
      .fn()
      .mockImplementation((v: Partial<SessionQuestion>) =>
        question({ ...v, id: 'new', createdAt: at('09:05') }),
      ),
    save: jest
      .fn()
      .mockImplementation((v: SessionQuestion) => Promise.resolve(v)),
    manager: {
      transaction: jest
        .fn()
        .mockImplementation((run: (m: unknown) => unknown) => run(manager)),
    },
  };
  const votes = { find: jest.fn().mockResolvedValue([]) };
  const sessions = { findById: jest.fn().mockResolvedValue({ id: 's1' }) };
  const delegates = {
    authorsByIds: jest
      .fn()
      .mockResolvedValue(
        new Map([
          ['d1', { name: 'Ada', organisation: 'PIC', avatarUrl: null }],
        ]),
      ),
  };
  const realtime = { emitToRoom: jest.fn() };
  const service = new QuestionsService(
    questions as unknown as Repository<SessionQuestion>,
    votes as unknown as Repository<QuestionVote>,
    sessions as unknown as SessionsService,
    delegates as unknown as DelegatesService,
    realtime as unknown as RealtimeService,
    new LiveTallyService(new FakeRedis() as unknown as Redis),
  );
  return {
    service,
    questions,
    votes,
    manager,
    txVotes,
    txQuestions,
    sessions,
    realtime,
  };
}

describe('rankQuestions', () => {
  it('puts open questions first by upvotes, then answered by recency', () => {
    const rows = [
      question({
        id: 'answered-early',
        status: QuestionStatus.ANSWERED,
        answeredAt: at('09:10'),
      }),
      question({ id: 'open-2-late', upvotes: 2, createdAt: at('09:30') }),
      question({ id: 'dismissed', status: QuestionStatus.DISMISSED }),
      question({ id: 'open-5', upvotes: 5, createdAt: at('09:20') }),
      question({
        id: 'answered-late',
        status: QuestionStatus.ANSWERED,
        answeredAt: at('09:40'),
      }),
      question({ id: 'open-2-early', upvotes: 2, createdAt: at('09:01') }),
    ];
    expect(rankQuestions(rows).map((q) => q.id)).toEqual([
      'open-5',
      'open-2-early',
      'open-2-late',
      'answered-late',
      'answered-early',
      'dismissed',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const rows = [
      question({ id: 'b', upvotes: 1 }),
      question({ id: 'a', upvotes: 9 }),
    ];
    rankQuestions(rows);
    expect(rows.map((q) => q.id)).toEqual(['b', 'a']);
  });
});

describe('QuestionsService.create', () => {
  it('refuses a sixth open question from the same delegate', async () => {
    const { service, questions, realtime } = build();
    questions.countBy.mockResolvedValue(MAX_OPEN_QUESTIONS_PER_DELEGATE);
    await expect(
      service.create('s1', delegate, { text: 'One more?' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(questions.save).not.toHaveBeenCalled();
    expect(realtime.emitToRoom).not.toHaveBeenCalled();
  });

  it('only counts open questions, so answered ones free up a slot', async () => {
    const { service, questions } = build();
    questions.countBy.mockResolvedValue(MAX_OPEN_QUESTIONS_PER_DELEGATE - 1);
    await service.create('s1', delegate, { text: 'Next?' });
    expect(questions.countBy).toHaveBeenCalledWith({
      sessionId: 's1',
      delegateId: 'd1',
      status: QuestionStatus.OPEN,
    });
    expect(questions.save).toHaveBeenCalledTimes(1);
  });

  it('answers the asker with mine=true but broadcasts mine=false', async () => {
    const { service, realtime } = build();
    const view = await service.create('s1', delegate, { text: 'Next?' });
    expect(view.mine).toBe(true);
    expect(view.author).toEqual({ id: 'd1', name: 'Ada', organisation: 'PIC' });
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'questions:s1',
      'question:new',
      expect.objectContaining({ id: 'new', mine: false, upvoted: false }),
    );
  });
});

describe('QuestionsService.list', () => {
  it('hides dismissed questions from delegates even when they ask for all', async () => {
    const { service, questions } = build();
    await service.list('s1', delegate, true);
    expect(questions.find).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sessionId: 's1',
        status: expect.anything(),
      }),
    });
  });

  it('shows dismissed questions to staff who ask for all', async () => {
    const { service, questions } = build();
    await service.list('s1', admin, true);
    expect(questions.find).toHaveBeenCalledWith({ where: { sessionId: 's1' } });
  });
});

describe('QuestionsService.toggleUpvote', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('adds a vote and bumps the counter when there was none', async () => {
    const { service, manager, txVotes, realtime, questions } = build(
      question({ upvotes: 3 }),
    );
    manager.findOneOrFail.mockResolvedValue(question({ upvotes: 4 }));
    const view = await service.toggleUpvote('q1', delegate);
    questions.find.mockResolvedValue([question({ upvotes: 4 })]);
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);
    expect(txVotes.insert).toHaveBeenCalledWith({
      questionId: 'q1',
      delegateId: 'd1',
    });
    expect(manager.increment).toHaveBeenCalledWith(
      SessionQuestion,
      { id: 'q1' },
      'upvotes',
      1,
    );
    expect(manager.decrement).not.toHaveBeenCalled();
    expect(view.upvoted).toBe(true);
    expect(view.upvotes).toBe(4);
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'questions:s1',
      'question:votes',
      { id: 'q1', upvotes: 4 },
    );
  });

  it('removes the vote and drops the counter on a second tap', async () => {
    const { service, manager, txVotes } = build(question({ upvotes: 4 }));
    txVotes.findOne.mockResolvedValue({ id: 'v1' });
    manager.findOneOrFail.mockResolvedValue(question({ upvotes: 3 }));
    const view = await service.toggleUpvote('q1', delegate);
    expect(txVotes.delete).toHaveBeenCalledWith({ id: 'v1' });
    expect(manager.decrement).toHaveBeenCalledWith(
      SessionQuestion,
      { id: 'q1' },
      'upvotes',
      1,
    );
    expect(txVotes.insert).not.toHaveBeenCalled();
    expect(view.upvoted).toBe(false);
    expect(view.upvotes).toBe(3);
  });

  it('broadcasts a burst of upvotes as one event per question per window', async () => {
    const { service, realtime, questions } = build(question({ upvotes: 0 }));
    for (let i = 0; i < 20; i++) await service.toggleUpvote('q1', delegate);
    expect(realtime.emitToRoom).not.toHaveBeenCalled();

    questions.find.mockResolvedValue([question({ upvotes: 20 })]);
    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    const votes = realtime.emitToRoom.mock.calls.filter(
      ([, event]) => event === 'question:votes',
    );
    expect(votes).toEqual([
      ['questions:s1', 'question:votes', { id: 'q1', upvotes: 20 }],
    ]);
    expect(questions.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ select: { id: true, upvotes: true } }),
    );
  });
});

describe('QuestionsService.setStatus', () => {
  it('stamps answeredAt once and broadcasts it as ISO', async () => {
    const { service, realtime } = build();
    const view = await service.setStatus('q1', QuestionStatus.ANSWERED, admin);
    expect(view.answeredAt).toEqual(expect.any(String));
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'questions:s1',
      'question:status',
      { id: 'q1', status: 'answered', answeredAt: view.answeredAt },
    );
  });

  it('clears answeredAt when a question is reopened', async () => {
    const { service } = build(
      question({ status: QuestionStatus.ANSWERED, answeredAt: at('09:30') }),
    );
    const view = await service.setStatus('q1', QuestionStatus.OPEN, admin);
    expect(view.answeredAt).toBeNull();
  });
});

describe('QuestionsService.remove', () => {
  it('lets the asker withdraw and clears the votes with it', async () => {
    const { service, txVotes, txQuestions, realtime } = build();
    await service.remove('q1', delegate);
    expect(txVotes.delete).toHaveBeenCalledWith({ questionId: 'q1' });
    expect(txQuestions.delete).toHaveBeenCalledWith({ id: 'q1' });
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'questions:s1',
      'question:deleted',
      { id: 'q1' },
    );
  });

  it('refuses another delegate but allows staff', async () => {
    const { service, txQuestions } = build();
    await expect(
      service.remove('q1', { ...delegate, id: 'someone-else' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(txQuestions.delete).not.toHaveBeenCalled();
    await service.remove('q1', admin);
    expect(txQuestions.delete).toHaveBeenCalledTimes(1);
  });
});
