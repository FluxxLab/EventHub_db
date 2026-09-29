import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, IsNull } from 'typeorm';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { eventRooms } from '../common/realtime/edition-room';
import { Counts, LiveTallyService } from '../common/tally/live-tally.service';
import { AnswerTriviaDto } from './dto/answer-trivia.dto';
import { CreateTriviaQuestionDto } from './dto/create-trivia.dto';
import { UpdateTriviaQuestionDto } from './dto/update-trivia.dto';
import { TriviaAnswer } from './entities/trivia-answer.entity';
import {
  TriviaOption,
  TriviaQuestion,
  TriviaStatus,
} from './entities/trivia-question.entity';
import {
  Leaderboard,
  MyStanding,
  TriviaLeaderboardService,
} from './trivia-leaderboard.service';
import { SPEED_WINDOW_SECONDS, scoreQuestionSql } from './trivia-scoring';

/**
 * Live answer counts per option. The key moved from `trivia:dist:{id}` when
 * the counts gained a Postgres seed; the old key is still deleted on remove.
 */
const disKey = (questionId: string) =>
  LiveTallyService.key('trivia', questionId);
const legacyDisKey = (questionId: string) => `trivia:dist:${questionId}`;

/** A question's event room plus the summit-wide one (see eventRooms). */
const roomsFor = (editionId: string | null | undefined) =>
  eventRooms(Rooms.trivia, Rooms.triviaEdition, editionId);

export interface DelegateQuestion {
  id: string;
  text: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  playersCount: number;
  editionId: string | null;
  /** When it went live (ISO), so a phone can count down from the right moment. */
  liveAt: string | null;
  /** The answer window the speed bonus runs over. */
  seconds: number;
}

export interface DelegateHistoryEntry {
  id: string;
  text: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  chosenOption: TriviaOption | null; // null when the delegate never answered
  correctOption: TriviaOption;
  explanation: string | null;
  correct: boolean | null; // null when unanswered - not the same as wrong
  /** What the answer scored; 0 when unanswered or wrong. */
  points: number;
  distribution: Record<TriviaOption, number>;
  playersCount: number;
}

/** A delegate's own outcome on one closed question, with their running total. */
export interface DelegateResult extends MyStanding {
  questionId: string;
  editionId: string | null;
  chosenOption: TriviaOption | null;
  correctOption: TriviaOption;
  correct: boolean | null;
  points: number;
}

@Injectable()
export class TriviaService {
  constructor(
    @InjectRepository(TriviaQuestion)
    private readonly questions: Repository<TriviaQuestion>,
    @InjectRepository(TriviaAnswer)
    private readonly answers: Repository<TriviaAnswer>,
    private readonly realtime: RealtimeService,
    private readonly tally: LiveTallyService,
    /** The current edition, which the app shows. Optional for the hand-built specs. */
    @Optional()
    private readonly access?: EditionAccessService,
    /** Per-event totals. Optional for the hand-built specs that are not about scoring. */
    @Optional()
    private readonly board?: TriviaLeaderboardService,
  ) {}

  /** The edition the app is showing, if one is current. */
  private async currentEdition(): Promise<string | null> {
    return (await this.access?.currentEdition()) ?? null;
  }

  /***
   * delegate facing
   */

  /**
   * The live question. With an event named, that event's only; without, the
   * current event's, or one made before events were linked.
   */
  async currentQuestion(editionId?: string): Promise<DelegateQuestion | null> {
    let q: TriviaQuestion | null;
    if (editionId) {
      q = await this.questions.findOneBy({
        status: TriviaStatus.LIVE,
        editionId,
      });
    } else {
      const current = await this.currentEdition();
      q =
        (current &&
          (await this.questions.findOneBy({
            status: TriviaStatus.LIVE,
            editionId: current,
          }))) ||
        (await this.questions.findOneBy({
          status: TriviaStatus.LIVE,
          editionId: IsNull(),
        }));
    }
    if (!q) return null;
    const distribution = await this.distribution(q.id);
    return this.toDelegateShape(q, this.players(distribution));
  }

  /**
   * A delegate's own trivia history: every closed question, with what they
   * answered, what was correct and what it scored.
   *
   * Questions they never answered are included on purpose - the reveal and the
   * explanation are the point, and omitting them would make the list look like
   * it had lost rows. `chosenOption` is null for those.
   *
   * Two bulk reads rather than a query per question: the whole summit is a
   * handful of questions and this renders as one list.
   */
  async historyFor(
    delegateId: string,
    editionId?: string,
  ): Promise<DelegateHistoryEntry[]> {
    const current = editionId ? null : await this.currentEdition();
    const closed = await this.questions.find({
      where: editionId
        ? [{ status: TriviaStatus.CLOSED, editionId }]
        : [
            { status: TriviaStatus.CLOSED, editionId: IsNull() },
            ...(current
              ? [{ status: TriviaStatus.CLOSED, editionId: current }]
              : []),
          ],
      order: { createdAt: 'DESC' },
    });
    if (closed.length === 0) return [];

    const mine = await this.answers.find({
      where: {
        delegateId,
        questionId: In(closed.map((q) => q.id)),
      },
    });
    const byQuestion = new Map(mine.map((a) => [a.questionId, a]));

    const distributions = await Promise.all(
      closed.map((q) => this.distribution(q.id)),
    );

    return closed.map((q, index) => {
      const answer = byQuestion.get(q.id);
      const chosenOption = answer?.chosenOption ?? null;
      const distribution = distributions[index];
      return {
        id: q.id,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
        chosenOption,
        correctOption: q.correctOption,
        explanation: q.explanation ?? null,
        // null (unanswered) is not the same as wrong, so it stays null
        correct:
          chosenOption === null ? null : chosenOption === q.correctOption,
        points: answer?.points ?? 0,
        distribution,
        playersCount: this.players(distribution),
      };
    });
  }

  /**
   * Records one answer. The reply says only that it was taken: whether it was
   * right, and what it scored, wait for the question to close - a reply that
   * said so would let the first phone to answer tell the room.
   */
  async answer(delegateId: string, questionId: string, dto: AnswerTriviaDto) {
    const question = await this.questions.findOneBy({
      id: questionId,
    });

    if (!question) throw new NotFoundException('Question not found');
    if (question.status !== TriviaStatus.LIVE) {
      throw new ConflictException('Question is not live');
    }

    // Seeded before the insert so a cold seed cannot already hold this answer.
    await this.tally.ensure(disKey(questionId), () =>
      this.countFromDb(questionId),
    );

    const result = await this.answers
      .createQueryBuilder()
      .insert()
      .values({ delegateId, questionId, chosenOption: dto.chosenOption })
      .orIgnore()
      .execute();

    if (result.identifiers.length === 0) {
      throw new ConflictException('Already answered');
    }

    await this.tally.apply(disKey(questionId), { [dto.chosenOption]: 1 });
    // One broadcast per question per second across every instance, carrying
    // the counts as they stand when it fires - not one per answer.
    await this.tally.coalesce(`trivia:${questionId}`, () =>
      this.emitDistribution(questionId),
    );

    return { accepted: true, questionId, chosenOption: dto.chosenOption };
  }

  /**
   * The caller's outcome on one question - correct or not, the points, their
   * running total and rank - once it has closed. Refused while it is live:
   * this is the answer key, one delegate at a time.
   */
  async resultFor(
    delegateId: string,
    questionId: string,
  ): Promise<DelegateResult> {
    const question = await this.questions.findOneBy({ id: questionId });
    if (!question) throw new NotFoundException('Question not found');
    if (question.status !== TriviaStatus.CLOSED)
      throw new ConflictException('Results are shown once the question closes');

    const answer = await this.answers.findOneBy({ delegateId, questionId });
    const chosenOption = answer?.chosenOption ?? null;
    const standing = await this.standingFor(question.editionId, delegateId);
    return {
      questionId,
      editionId: question.editionId,
      chosenOption,
      correctOption: question.correctOption,
      correct:
        chosenOption === null ? null : chosenOption === question.correctOption,
      points: answer?.points ?? 0,
      ...standing,
    };
  }

  /** The event's board, with the caller's own place whether or not they made the top. */
  async leaderboard(
    delegateId: string,
    editionId?: string,
    limit?: number,
  ): Promise<Leaderboard & { me: MyStanding }> {
    const event = editionId ?? (await this.currentEdition());
    if (!this.board)
      return {
        editionId: event,
        players: 0,
        top: [],
        me: { rank: null, score: 0, players: 0 },
      };
    const [board, me] = await Promise.all([
      this.board.top(event, limit),
      this.board.standing(event, delegateId),
    ]);
    return { ...board, me };
  }

  /**
   * Admin facing
   */
  async create(dto: CreateTriviaQuestionDto): Promise<TriviaQuestion> {
    const found = await this.questions.manager.query<unknown[]>(
      `SELECT 1 FROM editions WHERE id = $1`,
      [dto.editionId],
    );
    if (found.length === 0) throw new NotFoundException('Event not found');
    return this.questions.save(this.questions.create(dto));
  }

  /** One event's questions, or every question. */
  listAll(editionId?: string): Promise<TriviaQuestion[]> {
    return this.questions.find({
      where: editionId ? { editionId } : {},
      order: { createdAt: 'DESC' },
    });
  }

  async pushLive(id: string): Promise<TriviaQuestion> {
    const question = await this.questions.findOneBy({
      id,
    });

    if (!question) throw new NotFoundException('Question not found');

    // One live question per event: the one on show is closed properly -
    // scored and revealed - before this one replaces it. Another event's live
    // question is not ours to close.
    const live = await this.questions.find({
      where: {
        status: TriviaStatus.LIVE,
        editionId: question.editionId ?? IsNull(),
      },
    });
    for (const other of live) if (other.id !== id) await this.close(other.id);

    question.status = TriviaStatus.LIVE;
    question.liveAt = new Date();
    const saved = await this.questions.save(question);
    const distribution = await this.distribution(saved.id);
    this.realtime.emitToRoom(
      roomsFor(saved.editionId),
      'trivia:question',
      this.toDelegateShape(saved, this.players(distribution)),
    );
    return saved;
  }

  /**
   * Closing is when the answer becomes public, so it is also when answers are
   * scored and the event's board moves. Re-closing re-scores, harmlessly.
   */
  async close(id: string): Promise<TriviaQuestion> {
    const question = await this.questions.findOneBy({ id });

    if (!question) throw new NotFoundException('Question not found');
    question.status = TriviaStatus.CLOSED;
    const saved = await this.questions.save(question);
    // Scored and on the board before anyone hears it closed: the reveal is
    // what makes every phone ask for its result.
    await this.score(saved);
    await this.board?.rebuild(saved.editionId);
    // The final distribution is counted from Postgres, the source of truth,
    // and written back so history and stats read the same numbers.
    const distribution = this.toDistribution(await this.countFromDb(id));
    await this.tally.reset(disKey(id), distribution);
    this.realtime.emitToRoom(roomsFor(saved.editionId), 'trivia:closed', {
      questionId: id,
      editionId: saved.editionId,
      correctOption: saved.correctOption,
      explanation: saved.explanation,
      distribution,
    });
    await this.pushBoard(saved.editionId);
    return saved;
  }

  /**
   * Admin edit - typo fixes and corrections.
   *
   * A question that is already live is re-broadcast so phones showing it pick
   * the correction up immediately; answers already given are kept. Changing
   * `correctOption` re-scores those answers against the new key, which is the
   * intended behaviour when the key was simply entered wrong - on a closed
   * question that happens at once and the board follows.
   */
  async update(
    id: string,
    dto: UpdateTriviaQuestionDto,
  ): Promise<TriviaQuestion> {
    const question = await this.questions.findOneBy({ id });
    if (!question) throw new NotFoundException('Question not found');
    const rekeyed =
      dto.correctOption !== undefined &&
      dto.correctOption !== question.correctOption;

    Object.assign(question, dto);
    const saved = await this.questions.save(question);

    if (saved.status === TriviaStatus.LIVE) {
      const distribution = await this.distribution(saved.id);
      this.realtime.emitToRoom(
        roomsFor(saved.editionId),
        'trivia:question',
        this.toDelegateShape(saved, this.players(distribution)),
      );
    }
    if (saved.status === TriviaStatus.CLOSED && rekeyed) {
      await this.score(saved);
      await this.board?.rebuild(saved.editionId);
      await this.pushBoard(saved.editionId);
    }
    return saved;
  }

  /**
   * Admin removal: the question, every answer to it, and its Redis
   * distribution counter. Answers go too - leaving them would keep the
   * question in each delegate's history as an entry pointing at nothing, and
   * would count towards the certificate checklist for a question that no
   * longer exists. Its points leave the board with it.
   */
  async remove(id: string): Promise<void> {
    const question = await this.questions.findOneBy({ id });
    if (!question) throw new NotFoundException('Question not found');

    await this.answers.delete({ questionId: id });
    await this.tally.drop(disKey(id), legacyDisKey(id));
    await this.questions.delete({ id });

    // clears the card on any phone showing it, live or not
    this.realtime.emitToRoom(roomsFor(question.editionId), 'trivia:deleted', {
      questionId: id,
      editionId: question.editionId,
    });
    if (question.status === TriviaStatus.CLOSED) {
      await this.board?.rebuild(question.editionId);
      await this.pushBoard(question.editionId);
    }
  }

  async stats(id: string) {
    const distribution = await this.distribution(id);
    const playCount = this.players(distribution);
    return { questionId: id, playCount, distribution };
  }

  /**
   * Internals
   */

  /** Every answer to a closed question gets its points, in one statement. */
  private async score(question: TriviaQuestion): Promise<void> {
    await this.answers.query(scoreQuestionSql, [
      question.id,
      question.correctOption,
      question.liveAt ?? null,
    ]);
  }

  /**
   * Schedules one `trivia:leaderboard` push for the window, however many
   * questions close in it, read from the board when it fires. The push
   * carries the top of the board only; each phone asks for its own place
   * once per question (resultFor), so nothing per delegate is broadcast.
   */
  private async pushBoard(editionId: string | null): Promise<void> {
    const board = this.board;
    if (!board) return;
    await this.tally.coalesce(`trivia-board:${editionId ?? 'none'}`, async () =>
      this.realtime.emitToRoom(
        roomsFor(editionId),
        'trivia:leaderboard',
        await board.top(editionId),
      ),
    );
  }

  private async standingFor(
    editionId: string | null,
    delegateId: string,
  ): Promise<MyStanding> {
    if (!this.board) return { rank: null, score: 0, players: 0 };
    return this.board.standing(editionId, delegateId);
  }

  private players(distribution: Record<TriviaOption, number>): number {
    return Object.values(distribution).reduce((a, b) => a + b, 0);
  }

  private async distribution(
    questionId: string,
  ): Promise<Record<TriviaOption, number>> {
    return this.toDistribution(
      await this.tally.counts(disKey(questionId), () =>
        this.countFromDb(questionId),
      ),
    );
  }

  private toDistribution(raw: Counts): Record<TriviaOption, number> {
    return {
      [TriviaOption.A]: Number(raw.A ?? 0),
      [TriviaOption.B]: Number(raw.B ?? 0),
      [TriviaOption.C]: Number(raw.C ?? 0),
      [TriviaOption.D]: Number(raw.D ?? 0),
    };
  }

  /** Answers per option from Postgres; runs only to seed a cold key or to close. */
  private async countFromDb(questionId: string): Promise<Counts> {
    const rows = await this.answers
      .createQueryBuilder('a')
      .select('a.chosenOption', 'option')
      .addSelect('COUNT(*)::int', 'count')
      .where('a.questionId = :questionId', { questionId })
      .groupBy('a.chosenOption')
      .getRawMany<{ option: string; count: number | string }>();
    return Object.fromEntries(rows.map((r) => [r.option, Number(r.count)]));
  }

  /**
   * The coalesced `trivia:distribution` broadcast. Skipped once the question
   * is no longer live: `trivia:closed` has already carried the final
   * distribution, and a late live update must not land on top of it.
   */
  private async emitDistribution(questionId: string): Promise<void> {
    const question = await this.questions.findOneBy({ id: questionId });
    if (question?.status !== TriviaStatus.LIVE) return;
    this.realtime.emitToRoom(
      roomsFor(question.editionId),
      'trivia:distribution',
      {
        questionId,
        editionId: question.editionId,
        distribution: this.toDistribution(
          await this.tally.read(disKey(questionId)),
        ),
      },
    );
  }

  /** What delegates see of a question: never the answer or the explanation. */
  private toDelegateShape(
    q: TriviaQuestion,
    playersCount: number,
  ): DelegateQuestion {
    const { id, text, optionA, optionB, optionC, optionD } = q;
    return {
      id,
      text,
      optionA,
      optionB,
      optionC,
      optionD,
      playersCount,
      editionId: q.editionId ?? null,
      liveAt: q.liveAt ? new Date(q.liveAt).toISOString() : null,
      seconds: SPEED_WINDOW_SECONDS,
    };
  }
}
