import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { LiveTallyService } from '../common/tally/live-tally.service';
import { DelegatesService } from '../delegate/delegates.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { SessionsService } from '../sessions/sessions.service';
import { CreateQuestionDto } from './dto/questions.dto';
import { QuestionVote } from './entities/question-vote.entity';
import {
  QuestionStatus,
  SessionQuestion,
} from './entities/session-question.entity';

export interface QuestionView {
  id: string;
  sessionId: string;
  text: string;
  status: QuestionStatus;
  upvotes: number;
  createdAt: string;
  answeredAt: string | null;
  author: { id: string; name: string; organisation: string | null };
  /** The caller asked it. */
  mine: boolean;
  /** The caller has upvoted it. */
  upvoted: boolean;
}

/**
 * A delegate may hold this many unanswered questions in one session. Enough
 * for a genuine follow-up, few enough that one person cannot fill the queue.
 */
export const MAX_OPEN_QUESTIONS_PER_DELEGATE = 5;

const STATUS_RANK: Record<QuestionStatus, number> = {
  [QuestionStatus.OPEN]: 0,
  [QuestionStatus.ANSWERED]: 1,
  [QuestionStatus.DISMISSED]: 2,
};

/**
 * The order the moderator's screen and the delegate's list both show.
 *
 * Open questions first, most upvoted at the top and, among equals, the one
 * asked first (a tie should not favour whoever is refreshing). Answered ones
 * follow, most recently answered first, so the room sees what was just
 * addressed. Dismissed ones, when shown at all, trail by recency.
 *
 * Pure and exported so the ranking is testable without a database, and so a
 * client that receives a `question:votes` event can re-sort the same way.
 */
export function rankQuestions(rows: SessionQuestion[]): SessionQuestion[] {
  return [...rows].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === QuestionStatus.OPEN) {
      if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
      return a.createdAt.getTime() - b.createdAt.getTime();
    }
    if (a.status === QuestionStatus.ANSWERED) {
      return (
        (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0) ||
        b.createdAt.getTime() - a.createdAt.getTime()
      );
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

/** Questions whose upvotes changed since the session's last broadcast. */
const dirtyVotesKey = (sessionId: string) =>
  `tally:questions:dirty:${sessionId}`;

function isStaff(role: AccessTier): boolean {
  return (
    role === AccessTier.ADMIN ||
    role === AccessTier.SESSION_ADMIN ||
    role === AccessTier.EVENT_ADMIN
  );
}

@Injectable()
export class QuestionsService {
  constructor(
    @InjectRepository(SessionQuestion)
    private readonly questions: Repository<SessionQuestion>,
    @InjectRepository(QuestionVote)
    private readonly votes: Repository<QuestionVote>,
    private readonly sessions: SessionsService,
    private readonly delegates: DelegatesService,
    private readonly realtime: RealtimeService,
    private readonly live: LiveTallyService,
  ) {}

  async create(
    sessionId: string,
    user: AuthUser,
    dto: CreateQuestionDto,
  ): Promise<QuestionView> {
    // 404 for a session that does not exist
    await this.sessions.findById(sessionId);

    const open = await this.questions.countBy({
      sessionId,
      delegateId: user.id,
      status: QuestionStatus.OPEN,
    });
    if (open >= MAX_OPEN_QUESTIONS_PER_DELEGATE) {
      throw new BadRequestException(
        `You already have ${MAX_OPEN_QUESTIONS_PER_DELEGATE} open questions in this session`,
      );
    }

    const saved = await this.questions.save(
      this.questions.create({
        sessionId,
        delegateId: user.id,
        text: dto.text,
        status: QuestionStatus.OPEN,
        upvotes: 0,
        answeredAt: null,
      }),
    );
    const [view] = await this.views([saved], user.id);

    // Everyone else in the room sees it as somebody else's, unvoted; the
    // asker's own response carries `mine: true`.
    this.realtime.emitToRoom(Rooms.questions(sessionId), 'question:new', {
      ...view,
      mine: false,
      upvoted: false,
    });
    return view;
  }

  async list(
    sessionId: string,
    user: AuthUser,
    all = false,
  ): Promise<QuestionView[]> {
    const includeDismissed = all && isStaff(user.role);
    const rows = await this.questions.find({
      where: {
        sessionId,
        ...(includeDismissed ? {} : { status: Not(QuestionStatus.DISMISSED) }),
      },
    });
    return this.views(rankQuestions(rows), user.id);
  }

  /**
   * Adds or removes the caller's upvote.
   *
   * The vote row and the counter move together in one transaction, and the
   * counter moves by SQL increment rather than by writing back a value read
   * a moment earlier - two delegates tapping at once would otherwise both
   * write the same number and lose one of the votes.
   */
  async toggleUpvote(id: string, user: AuthUser): Promise<QuestionView> {
    const question = await this.questions.findOne({ where: { id } });
    if (!question) throw new NotFoundException('Question not found');

    const { updated, upvoted } = await this.questions.manager.transaction(
      async (manager) => {
        const votes = manager.getRepository(QuestionVote);
        const existing = await votes.findOne({
          where: { questionId: id, delegateId: user.id },
        });
        if (existing) {
          await votes.delete({ id: existing.id });
          await manager.decrement(SessionQuestion, { id }, 'upvotes', 1);
        } else {
          await votes.insert({ questionId: id, delegateId: user.id });
          await manager.increment(SessionQuestion, { id }, 'upvotes', 1);
        }
        const fresh = await manager.findOneOrFail(SessionQuestion, {
          where: { id },
        });
        return { updated: fresh, upvoted: !existing };
      },
    );

    // Coalesced per session: at most one round of `question:votes` a second
    // across every instance, one event per question that changed.
    await this.live.markDirty(dirtyVotesKey(question.sessionId), id);
    await this.live.coalesce(`questions:${question.sessionId}`, () =>
      this.emitVotes(question.sessionId),
    );
    const [view] = await this.views([updated], user.id, upvoted);
    return view;
  }

  async setStatus(
    id: string,
    status: QuestionStatus,
    user: AuthUser,
  ): Promise<QuestionView> {
    const question = await this.questions.findOne({ where: { id } });
    if (!question) throw new NotFoundException('Question not found');

    question.status = status;
    // Marking answered stamps the moment once; re-opening clears it so the
    // ranking does not treat a re-answered question as old news.
    question.answeredAt =
      status === QuestionStatus.ANSWERED
        ? (question.answeredAt ?? new Date())
        : null;
    const saved = await this.questions.save(question);

    this.realtime.emitToRoom(
      Rooms.questions(saved.sessionId),
      'question:status',
      {
        id: saved.id,
        status: saved.status,
        answeredAt: saved.answeredAt?.toISOString() ?? null,
      },
    );
    const [view] = await this.views([saved], user.id);
    return view;
  }

  /** The asker can withdraw their question; staff can remove anyone's. */
  async remove(id: string, user: AuthUser): Promise<void> {
    const question = await this.questions.findOne({ where: { id } });
    if (!question) throw new NotFoundException('Question not found');
    if (question.delegateId !== user.id && !isStaff(user.role)) {
      throw new ForbiddenException(
        'Only the asker or an admin can delete this question',
      );
    }

    // Votes carry no foreign key back to the question, so they go in the
    // same transaction rather than being left as orphans.
    await this.questions.manager.transaction(async (manager) => {
      await manager.getRepository(QuestionVote).delete({ questionId: id });
      await manager.getRepository(SessionQuestion).delete({ id });
    });
    this.realtime.emitToRoom(
      Rooms.questions(question.sessionId),
      'question:deleted',
      { id },
    );
  }

  /**
   * The coalesced upvote broadcast for one session. The count is read from
   * the `upvotes` column when it fires - already an atomic SQL counter, so
   * there is no per-vote GROUP BY to replace - in one query for every
   * question that changed in the window. The event and payload are the same
   * `question:votes` { id, upvotes } a single toggle used to send.
   */
  private async emitVotes(sessionId: string): Promise<void> {
    const ids = await this.live.drainDirty(dirtyVotesKey(sessionId));
    if (ids.length === 0) return;
    const rows = await this.questions.find({
      where: { id: In(ids) },
      select: { id: true, upvotes: true },
    });
    for (const row of rows) {
      this.realtime.emitToRoom(Rooms.questions(sessionId), 'question:votes', {
        id: row.id,
        upvotes: row.upvotes,
      });
    }
  }

  /* -------------------------------------------------------------------- views */

  /**
   * Two bulk lookups (authors, the viewer's votes) rather than one per row:
   * a queue is read whole. `upvotedOverride` lets the toggle answer from
   * what it just did instead of re-reading the vote it wrote.
   */
  private async views(
    rows: SessionQuestion[],
    viewerId: string,
    upvotedOverride?: boolean,
  ): Promise<QuestionView[]> {
    if (rows.length === 0) return [];
    const authors = await this.delegates.authorsByIds(
      rows.map((r) => r.delegateId),
    );
    const mine =
      upvotedOverride === undefined
        ? new Set(
            (
              await this.votes.find({
                where: {
                  delegateId: viewerId,
                  questionId: In(rows.map((r) => r.id)),
                },
                select: { questionId: true },
              })
            ).map((v) => v.questionId),
          )
        : null;

    return rows.map((r) => {
      const author = authors.get(r.delegateId);
      return {
        id: r.id,
        sessionId: r.sessionId,
        text: r.text,
        status: r.status,
        upvotes: r.upvotes,
        createdAt: r.createdAt.toISOString(),
        answeredAt: r.answeredAt?.toISOString() ?? null,
        author: {
          id: r.delegateId,
          name: author?.name ?? 'Delegate',
          organisation: author?.organisation ?? null,
        },
        mine: r.delegateId === viewerId,
        upvoted: mine ? mine.has(r.id) : (upvotedOverride ?? false),
      };
    });
  }
}
