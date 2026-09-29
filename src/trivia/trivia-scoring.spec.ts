import type Redis from 'ioredis';
import type { Repository } from 'typeorm';
import { ConflictException } from '@nestjs/common';
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
import type { TriviaLeaderboardService } from './trivia-leaderboard.service';
import { pointsFor, scoreQuestionSql } from './trivia-scoring';
import { TriviaService } from './trivia.service';

describe('pointsFor', () => {
  it('gives nothing for a wrong answer, however fast', () => {
    expect(pointsFor(false, 0)).toBe(0);
    expect(pointsFor(false, null)).toBe(0);
  });

  it('gives 100 plus a bonus that falls from 50 to 0 over 30 s', () => {
    expect(pointsFor(true, 0)).toBe(150);
    expect(pointsFor(true, 3_000)).toBe(145);
    expect(pointsFor(true, 15_000)).toBe(125);
    expect(pointsFor(true, 29_999)).toBe(100);
    expect(pointsFor(true, 30_000)).toBe(100);
    expect(pointsFor(true, 120_000)).toBe(100);
  });

  it('never exceeds the maximum when clocks disagree, and scores the base with no start time', () => {
    expect(pointsFor(true, -5_000)).toBe(150);
    expect(pointsFor(true, null)).toBe(100);
  });

  it('is what the scoring UPDATE computes', () => {
    // the SQL is the implementation; its constants must be the same ones
    expect(scoreQuestionSql).toContain('THEN 0');
    expect(scoreQuestionSql).toContain('IS NULL THEN 100');
    expect(scoreQuestionSql).toContain('100 + LEAST(50');
    expect(scoreQuestionSql).toContain('/ 30');
  });
});

describe('TriviaService scoring', () => {
  const liveAt = new Date('2026-09-26T10:00:00Z');

  function build(status: TriviaStatus) {
    const question = {
      id: 'q1',
      text: 'Q',
      optionA: 'a',
      optionB: 'b',
      optionC: 'c',
      optionD: 'd',
      correctOption: TriviaOption.B,
      explanation: 'Because',
      status,
      editionId: 'gs27',
      liveAt,
    } as unknown as TriviaQuestion;
    const order: string[] = [];
    const questions = {
      findOneBy: jest.fn().mockResolvedValue(question),
      save: jest.fn((q: TriviaQuestion) => Promise.resolve(q)),
    };
    const answers = {
      query: jest.fn(() => {
        order.push('score');
        return Promise.resolve(undefined);
      }),
      findOneBy: jest.fn().mockResolvedValue({
        chosenOption: TriviaOption.B,
        points: 140,
      }),
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
          getRawMany: () => Promise.resolve([{ option: 'B', count: 3 }]),
        };
        return qb;
      }),
    };
    const realtime = {
      emitToRoom: jest.fn((_room: unknown, event: string) => order.push(event)),
    };
    const board = {
      rebuild: jest.fn(() => {
        order.push('rebuild');
        return Promise.resolve();
      }),
      top: jest.fn().mockResolvedValue({
        editionId: 'gs27',
        players: 3,
        top: [{ rank: 1, delegateId: 'd1', name: 'Ada', score: 140 }],
      }),
      standing: jest
        .fn()
        .mockResolvedValue({ rank: 2, score: 240, players: 3 }),
    };
    const service = new TriviaService(
      questions as unknown as Repository<TriviaQuestion>,
      answers as unknown as Repository<TriviaAnswer>,
      realtime as unknown as RealtimeService,
      new LiveTallyService(new FakeRedis() as unknown as Redis),
      undefined,
      board as unknown as TriviaLeaderboardService,
    );
    return { service, answers, realtime, board, order };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('takes an answer without saying whether it was right', async () => {
    const { service } = build(TriviaStatus.LIVE);
    const reply = await service.answer('d1', 'q1', {
      chosenOption: TriviaOption.B,
    });
    expect(reply).toEqual({
      accepted: true,
      questionId: 'q1',
      chosenOption: TriviaOption.B,
    });
    expect(reply).not.toHaveProperty('correct');
    expect(reply).not.toHaveProperty('correctOption');
  });

  it('refuses a result while the question is live', async () => {
    const { service, answers } = build(TriviaStatus.LIVE);
    await expect(service.resultFor('d1', 'q1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(answers.findOneBy).not.toHaveBeenCalled();
  });

  it('scores and rebuilds the board before announcing the close, then pushes the board once', async () => {
    const { service, answers, realtime, order } = build(TriviaStatus.LIVE);
    await service.close('q1');
    await service.close('q1'); // re-closing re-scores; still one board push

    expect(answers.query).toHaveBeenCalledWith(scoreQuestionSql, [
      'q1',
      TriviaOption.B,
      liveAt,
    ]);
    expect(order.slice(0, 3)).toEqual(['score', 'rebuild', 'trivia:closed']);
    expect(realtime.emitToRoom).not.toHaveBeenCalledWith(
      expect.anything(),
      'trivia:leaderboard',
      expect.anything(),
    );

    await jest.advanceTimersByTimeAsync(TALLY_EMIT_WINDOW_MS + 100);

    const calls = realtime.emitToRoom.mock.calls as unknown as [
      unknown,
      string,
      unknown,
    ][];
    const boards = calls.filter(([, event]) => event === 'trivia:leaderboard');
    expect(boards).toHaveLength(1);
    expect(boards[0][0]).toEqual(['trivia:gs27', 'trivia']);
    expect(boards[0][2]).toMatchObject({ players: 3 });
  });

  it('gives a delegate their points, total and rank once it has closed', async () => {
    const { service } = build(TriviaStatus.CLOSED);
    await expect(service.resultFor('d1', 'q1')).resolves.toEqual({
      questionId: 'q1',
      editionId: 'gs27',
      chosenOption: TriviaOption.B,
      correctOption: TriviaOption.B,
      correct: true,
      points: 140,
      rank: 2,
      score: 240,
      players: 3,
    });
  });

  it('re-scores a closed question when its answer key is corrected', async () => {
    const { service, answers, board } = build(TriviaStatus.CLOSED);
    await service.update('q1', { correctOption: TriviaOption.C });
    expect(answers.query).toHaveBeenCalledWith(scoreQuestionSql, [
      'q1',
      TriviaOption.C,
      liveAt,
    ]);
    expect(board.rebuild).toHaveBeenCalledWith('gs27');

    answers.query.mockClear();
    await service.update('q1', { text: 'Typo fixed' });
    expect(answers.query).not.toHaveBeenCalled();
  });
});
