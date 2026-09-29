import type Redis from 'ioredis';
import type { Repository } from 'typeorm';
import type { RealtimeService } from '../common/realtime/realtime.service';
import { FakeRedis } from '../common/tally/fake-redis.testing';
import {
  LiveTallyService,
  TALLY_EMIT_WINDOW_MS,
} from '../common/tally/live-tally.service';
import { TriviaAnswer } from './entities/trivia-answer.entity';
import {
  TriviaOption,
  TriviaQuestion,
  TriviaStatus,
} from './entities/trivia-question.entity';
import { TriviaService } from './trivia.service';
import { NotFoundException } from '@nestjs/common';

/**
 * A live question is answered by the whole room within seconds, so the
 * distribution must be counted in Redis and broadcast at most once a second,
 * not recounted and pushed to every phone on every answer.
 */
function build(status = TriviaStatus.LIVE) {
  const question = {
    id: 'q1',
    text: 'Q',
    optionA: 'a',
    optionB: 'b',
    optionC: 'c',
    optionD: 'd',
    correctOption: TriviaOption.B,
    explanation: null,
    status,
  } as unknown as TriviaQuestion;
  const questions = {
    findOneBy: jest.fn().mockResolvedValue(question),
    save: jest.fn((q: TriviaQuestion) => Promise.resolve(q)),
  };
  const seed = jest.fn().mockResolvedValue([{ option: 'A', count: '2' }]);
  const answers = {
    createQueryBuilder: jest.fn(() => {
      const qb = {
        insert: () => qb,
        values: () => qb,
        orIgnore: () => qb,
        execute: () => Promise.resolve({ identifiers: [{ id: 'x' }] }),
        select: () => qb,
        addSelect: () => qb,
        where: () => qb,
        groupBy: () => qb,
        getRawMany: seed,
      };
      return qb;
    }),
  };
  const realtime = { emitToRoom: jest.fn() };
  const service = new TriviaService(
    questions as unknown as Repository<TriviaQuestion>,
    answers as unknown as Repository<TriviaAnswer>,
    realtime as unknown as RealtimeService,
    new LiveTallyService(new FakeRedis() as unknown as Redis),
  );
  return { service, questions, realtime, seed };
}

describe('TriviaService.answer live distribution', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('seeds once, counts in Redis and broadcasts once per window', async () => {
    const { service, realtime, seed } = build();

    for (let i = 0; i < 30; i++) {
      await service.answer(`d${i}`, 'q1', {
        chosenOption: i % 2 ? TriviaOption.B : TriviaOption.C,
      });
    }
    expect(seed).toHaveBeenCalledTimes(1);
    expect(realtime.emitToRoom).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).toHaveBeenCalledTimes(1);
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'trivia',
      'trivia:distribution',
      { questionId: 'q1', distribution: { A: 2, B: 15, C: 15, D: 0 } },
    );
  });

  it('drops the live update once the question has closed', async () => {
    const { service, realtime, questions } = build();
    await service.answer('d1', 'q1', { chosenOption: TriviaOption.A });
    questions.findOneBy.mockResolvedValue({ status: TriviaStatus.CLOSED });

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    expect(realtime.emitToRoom).not.toHaveBeenCalled();
  });
});

describe('TriviaService per event', () => {
  const question = (over: Partial<TriviaQuestion>) =>
    ({
      id: 'q',
      text: 'Q',
      optionA: 'a',
      optionB: 'b',
      optionC: 'c',
      optionD: 'd',
      correctOption: TriviaOption.A,
      status: TriviaStatus.DRAFT,
      editionId: 'gs27',
      ...over,
    }) as TriviaQuestion;

  function scoped(rows: TriviaQuestion[]) {
    const questions = {
      findOneBy: jest.fn((where: Partial<TriviaQuestion>) =>
        Promise.resolve(
          rows.find((r) =>
            Object.entries(where).every(([k, v]) =>
              // IsNull() arrives as a FindOperator; the rows' null stands for it
              typeof v === 'object' && v !== null
                ? r[k as keyof TriviaQuestion] === null
                : r[k as keyof TriviaQuestion] === v,
            ),
          ) ?? null,
        ),
      ),
      find: jest.fn(({ where }: { where: Partial<TriviaQuestion> }) =>
        Promise.resolve(
          rows.filter(
            (r) => r.status === where.status && r.editionId === where.editionId,
          ),
        ),
      ),
      update: jest.fn().mockResolvedValue({}),
      save: jest.fn((q: TriviaQuestion) => Promise.resolve(q)),
      create: jest.fn((q: Partial<TriviaQuestion>) => q),
      manager: { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) },
    };
    const answers = {
      query: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => {
        const qb = {
          select: () => qb,
          addSelect: () => qb,
          where: () => qb,
          groupBy: () => qb,
          getRawMany: () => Promise.resolve([]),
        };
        return qb;
      }),
    };
    const access = { currentEdition: jest.fn().mockResolvedValue('gs27') };
    const realtime = { emitToRoom: jest.fn() };
    const service = new TriviaService(
      questions as unknown as Repository<TriviaQuestion>,
      answers as unknown as Repository<TriviaAnswer>,
      realtime as unknown as RealtimeService,
      new LiveTallyService(new FakeRedis() as unknown as Redis),
      access as never,
    );
    return { service, questions, answers, realtime };
  }

  it('files a new question under the event it names, which must exist', async () => {
    const { service, questions } = scoped([]);
    questions.manager.query.mockResolvedValueOnce([]);
    await expect(
      service.create({
        text: 'Q',
        optionA: 'a',
        optionB: 'b',
        optionC: 'c',
        optionD: 'd',
        correctOption: TriviaOption.A,
        editionId: 'nowhere',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(questions.create).not.toHaveBeenCalled();

    await service.create({
      text: 'Q',
      optionA: 'a',
      optionB: 'b',
      optionC: 'c',
      optionD: 'd',
      correctOption: TriviaOption.A,
      editionId: 'pww',
    });
    expect(questions.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ editionId: 'pww' }),
    );
  });

  it("going live closes, scores and reveals only that event's live question", async () => {
    const { service, answers, realtime } = scoped([
      question({ id: 'q-pww', editionId: 'pww' }),
      question({ id: 'q-old', editionId: 'pww', status: TriviaStatus.LIVE }),
      question({ id: 'q-gs27', editionId: 'gs27', status: TriviaStatus.LIVE }),
    ]);
    const live = await service.pushLive('q-pww');

    expect(live.liveAt).toBeInstanceOf(Date);
    // the one it replaces is scored and revealed, in its own event's room
    expect(answers.query).toHaveBeenCalledTimes(1);
    const [[, params]] = answers.query.mock.calls as [string, unknown[]][];
    expect(params[0]).toBe('q-old');
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      ['trivia:pww', 'trivia'],
      'trivia:closed',
      expect.objectContaining({ questionId: 'q-old', editionId: 'pww' }),
    );
    // another event's live question is left alone
    expect(realtime.emitToRoom).not.toHaveBeenCalledWith(
      expect.anything(),
      'trivia:closed',
      expect.objectContaining({ questionId: 'q-gs27' }),
    );
    const emits = realtime.emitToRoom.mock.calls as [
      unknown,
      string,
      unknown,
    ][];
    const pushed = emits.find(([, event]) => event === 'trivia:question');
    expect(pushed?.[0]).toEqual(['trivia:pww', 'trivia']);
    // what phones get never carries the answer
    expect(pushed?.[2]).not.toHaveProperty('correctOption');
    expect(pushed?.[2]).not.toHaveProperty('explanation');
    expect(pushed?.[2]).toMatchObject({ id: 'q-pww', seconds: 30 });
  });

  it("answers with the named event's live question only", async () => {
    const { service } = scoped([
      question({ id: 'q-pww', editionId: 'pww', status: TriviaStatus.LIVE }),
      question({ id: 'q-gs27', editionId: 'gs27', status: TriviaStatus.LIVE }),
    ]);
    await expect(service.currentQuestion('pww')).resolves.toMatchObject({
      id: 'q-pww',
      editionId: 'pww',
    });
    await expect(service.currentQuestion('other')).resolves.toBeNull();
  });

  it("shows delegates the current event's live question, not another's", async () => {
    const { service } = scoped([
      question({ id: 'q-pww', editionId: 'pww', status: TriviaStatus.LIVE }),
      question({ id: 'q-gs27', editionId: 'gs27', status: TriviaStatus.LIVE }),
    ]);
    await expect(service.currentQuestion()).resolves.toMatchObject({
      id: 'q-gs27',
    });
  });
});
