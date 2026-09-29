import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import {
  HiddenFilter,
  QueryAllCommentsDto,
} from './dto/query-all-comments.dto';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { QueryCommentsDto } from './dto/query-comments.dto';
import { SessionComment } from './entities/session-comment.entity';
import { CommentVote, VoteValue } from './entities/comment-vote.entity';
import { DiscussionLock } from './entities/discussion-lock.entity';
import { DelegatesService } from '../delegate/delegates.service';
import { SecurityService } from '../security/security.service';

/** How the room responded, read off the vote counters. `none` is kept distinct
 *  from `neutral`: nobody voting is not the same as the votes cancelling out. */
export type Reaction = 'positive' | 'negative' | 'neutral' | 'none';

/** Whether a thread takes new comments, as the app and the console read it. */
export interface ThreadState {
  sessionId: string;
  locked: boolean;
  lockedAt: Date | null;
}

/** What a comment on a locked thread gets: 423 Locked, with a sentence to show. */
export const THREAD_LOCKED_MESSAGE =
  'The organiser has closed this discussion to new comments';

/** Postgres unique_violation, as TypeORM's QueryFailedError carries it. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

function reactionOf(likes: number, dislikes: number): Reaction {
  if (likes === 0 && dislikes === 0) return 'none';
  if (likes > dislikes) return 'positive';
  if (likes < dislikes) return 'negative';
  return 'neutral';
}

@Injectable()
export class DiscussionService {
  constructor(
    @InjectRepository(SessionComment)
    private readonly comments: Repository<SessionComment>,
    @InjectRepository(CommentVote)
    private readonly votes: Repository<CommentVote>,
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeService,
    private readonly delegateService: DelegatesService,
    private readonly securityService: SecurityService,
    @InjectRepository(DiscussionLock)
    private readonly locks: Repository<DiscussionLock>,
  ) {}

  async postComment(
    sessionId: string,
    authorId: string,
    dto: CreateCommentDto,
  ) {
    /**
     * returns 404 if the session comment  doesnt exist
     */
    await this.sessions.findById(sessionId);

    // The app re-sends a comment after a timeout, or from its offline queue,
    // with the id it gave it when it was written. One already saved is handed
    // back as it is (even if the thread was locked since), never posted twice.
    const clientId = dto.clientId ?? null;
    if (clientId) {
      const earlier = await this.savedAs(authorId, clientId, sessionId);
      if (earlier) return earlier;
    }

    // A comment already in flight when the lock lands can still be saved;
    // the lock is a moderator's call, not a transaction boundary.
    if (await this.locks.existsBy({ sessionId }))
      throw new HttpException(
        {
          statusCode: HttpStatus.LOCKED,
          error: 'Locked',
          message: THREAD_LOCKED_MESSAGE,
        },
        HttpStatus.LOCKED,
      );

    let comment: SessionComment;
    try {
      comment = await this.comments.save(
        this.comments.create({ sessionId, authorId, body: dto.body, clientId }),
      );
    } catch (error) {
      // Two copies of the same retry raced; the unique index let one in.
      const earlier =
        clientId && isUniqueViolation(error)
          ? await this.savedAs(authorId, clientId, sessionId)
          : null;
      if (earlier) return earlier;
      throw error;
    }

    await this.emitComment(comment);
    return comment;
  }

  /** The author's comment saved under this client id; refuses one reused on another thread. */
  private async savedAs(
    authorId: string,
    clientId: string,
    sessionId: string,
  ): Promise<SessionComment | null> {
    const earlier = await this.comments.findOneBy({ authorId, clientId });
    if (earlier && earlier.sessionId !== sessionId)
      throw new ConflictException(
        'This comment was already posted in another discussion',
      );
    return earlier;
  }

  /* ------------------------------------------------------------------ lock */

  async threadState(sessionId: string): Promise<ThreadState> {
    const lock = await this.locks.findOneBy({ sessionId });
    return {
      sessionId,
      locked: Boolean(lock),
      lockedAt: lock?.lockedAt ?? null,
    };
  }

  /**
   * Closes a thread to new comments. Idempotent: locking a locked thread
   * keeps the original time and moderator. Everyone in the room hears it, so
   * the composer gives way to the locked notice without a reload.
   */
  async lockThread(sessionId: string, adminId: string): Promise<ThreadState> {
    await this.sessions.findById(sessionId); // 404 for a session that does not exist
    await this.locks
      .createQueryBuilder()
      .insert()
      .values({ sessionId, lockedBy: adminId })
      .orIgnore()
      .execute();
    return this.announceState(await this.threadState(sessionId));
  }

  /** Opens a thread again. Idempotent, and announced like the lock. */
  async unlockThread(sessionId: string): Promise<ThreadState> {
    await this.sessions.findById(sessionId);
    await this.locks.delete({ sessionId });
    return this.announceState({ sessionId, locked: false, lockedAt: null });
  }

  private announceState(state: ThreadState): ThreadState {
    this.realtime.emitToRoom(
      Rooms.discussion(state.sessionId),
      'discussion:locked',
      state,
    );
    return state;
  }

  /**
   * Sends a comment to everyone in its session's room. The live payload
   * carries the same author fields as the list, so a comment arriving over the
   * socket renders with a name and photo instead of the anonymous "Delegate"
   * placeholder it used to get.
   */
  private async emitComment(comment: SessionComment): Promise<void> {
    const author = (
      await this.delegateService.authorsByIds([comment.authorId])
    ).get(comment.authorId);

    this.realtime.emitToRoom(
      Rooms.discussion(comment.sessionId),
      'discussion:comment',
      {
        id: comment.id,
        sessionId: comment.sessionId,
        authorId: comment.authorId,
        authorName: author?.name ?? 'Delegate',
        authorOrganisation: author?.organisation ?? null,
        authorAvatarUrl: author?.avatarUrl ?? null,
        body: comment.body,
        createAt: comment.createdAt,
      },
    );
  }

  async listComments(
    sessionId: string,
    query: QueryCommentsDto,
    viewerId?: string,
  ) {
    const comments = await this.comments.find({
      where: {
        sessionId,
        hiddenAt: IsNull(),
        ...(query.before && { createdAt: LessThan(new Date(query.before)) }),
      },
      order: { createdAt: 'DESC' },
      take: query.limit,
    });

    const authors = await this.delegateService.authorsByIds(
      comments.map((c) => c.authorId),
    );

    /**
     * One bulk lookup for the viewer's own votes rather than a per-row query:
     * the client needs to render its buttons in the voted state, and a thread
     * is read all at once.
     */
    const myVotes = await this.votesByViewer(
      viewerId,
      comments.map((c) => c.id),
    );

    return comments.map((c) => ({
      ...c,
      authorName: authors.get(c.authorId)?.name ?? 'Delegate',
      authorOrganisation: authors.get(c.authorId)?.organisation ?? null,
      authorAvatarUrl: authors.get(c.authorId)?.avatarUrl ?? null,
      myVote: myVotes.get(c.id) ?? null,
    }));
  }

  private async votesByViewer(
    viewerId: string | undefined,
    commentIds: string[],
  ): Promise<Map<string, VoteValue>> {
    if (!viewerId || commentIds.length === 0) return new Map();
    const rows = await this.votes.find({
      where: { delegateId: viewerId, commentId: In(commentIds) },
    });
    return new Map(rows.map((r) => [r.commentId, r.value]));
  }

  /**
   * Casts, changes or clears one delegate's vote on a comment.
   *
   * The counters and the vote row move together in a transaction, and the
   * counters move by SQL increment rather than by writing a value read a moment
   * earlier - two delegates voting at once would otherwise both write the same
   * number and lose one of the votes.
   */
  async vote(commentId: string, delegateId: string, value: VoteValue | null) {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');

    return this.comments.manager.transaction(async (manager) => {
      const votes = manager.getRepository(CommentVote);
      const existing = await votes.findOne({
        where: { commentId, delegateId },
      });
      const previous = existing?.value ?? null;

      if (previous !== value) {
        if (value === null) {
          await votes.delete({ commentId, delegateId });
        } else if (existing) {
          await votes.update({ id: existing.id }, { value });
        } else {
          await votes.insert({ commentId, delegateId, value });
        }

        let likeDelta = 0;
        let dislikeDelta = 0;
        if (previous === VoteValue.LIKE) likeDelta -= 1;
        if (previous === VoteValue.DISLIKE) dislikeDelta -= 1;
        if (value === VoteValue.LIKE) likeDelta += 1;
        if (value === VoteValue.DISLIKE) dislikeDelta += 1;

        if (likeDelta !== 0) {
          await manager.increment(
            SessionComment,
            { id: commentId },
            'likes',
            likeDelta,
          );
        }
        if (dislikeDelta !== 0) {
          await manager.increment(
            SessionComment,
            { id: commentId },
            'dislikes',
            dislikeDelta,
          );
        }
      }

      const updated = await manager.findOneOrFail(SessionComment, {
        where: { id: commentId },
      });
      return {
        id: commentId,
        likes: updated.likes,
        dislikes: updated.dislikes,
        myVote: value,
      };
    });
  }

  /**
   * Every thread in one place, for moderation.
   *
   * Deliberately different from listComments, which serves delegates: that one
   * hides hidden comments and is scoped to a session. A moderator works the
   * other way round - across sessions, newest first, with hidden and flagged
   * rows visible, because those are the ones needing a second look.
   */
  async listAllComments(query: QueryAllCommentsDto) {
    const hidden = query.hidden ?? HiddenFilter.INCLUDE;

    const comments = await this.comments.find({
      where: {
        ...(query.sessionId && { sessionId: query.sessionId }),
        ...(query.flagged && { flagged: true }),
        ...(hidden === HiddenFilter.EXCLUDE && { hiddenAt: IsNull() }),
        ...(hidden === HiddenFilter.ONLY && { hiddenAt: Not(IsNull()) }),
        ...(query.before && { createdAt: LessThan(new Date(query.before)) }),
      },
      order: { createdAt: 'DESC' },
      take: query.limit,
    });

    // Two bulk lookups rather than a join per row: a moderation sweep reads
    // hundreds of comments spanning a handful of sessions and authors.
    const [authors, sessionTitles] = await Promise.all([
      this.delegateService.namesByIds(comments.map((c) => c.authorId)),
      this.sessionTitles(comments.map((c) => c.sessionId)),
    ]);

    return comments.map((c) => ({
      ...c,
      authorName: authors.get(c.authorId)?.name ?? 'Delegate',
      authorOrganisation: authors.get(c.authorId)?.organisation ?? null,
      // Without this a cross-session list gives a moderator no idea where a
      // comment came from.
      sessionTitle: sessionTitles.get(c.sessionId) ?? 'Unknown session',
    }));
  }

  /**
   * One row per session, whether or not anyone has posted.
   *
   * listAllComments answers "what has been said"; this answers "where can it
   * be said". A thread with no comments is invisible to the former, which
   * makes a freshly created forum look like it failed to exist.
   */
  async listThreads() {
    const sessions = await this.sessions.list({});

    const counts = await this.comments
      .createQueryBuilder('c')
      .select('c.sessionId', 'sessionId')
      .addSelect('COUNT(*)', 'comments')
      .addSelect('COUNT(*) FILTER (WHERE c.flagged)', 'flagged')
      .addSelect('COUNT(*) FILTER (WHERE c."hiddenAt" IS NOT NULL)', 'hidden')
      .addSelect('MAX(c."createdAt")', 'lastAt')
      .groupBy('c.sessionId')
      .getRawMany<{
        sessionId: string;
        comments: string;
        flagged: string;
        hidden: string;
        lastAt: Date | null;
      }>();

    const byId = new Map(counts.map((row) => [row.sessionId, row]));
    const locked = new Set(
      (await this.locks.find({ select: { sessionId: true } })).map(
        (l) => l.sessionId,
      ),
    );

    return sessions.map((session) => {
      const row = byId.get(session.id);
      return {
        sessionId: session.id,
        title: session.title,
        track: session.track,
        type: session.type,
        room: session.room,
        // Counts arrive as strings from a raw aggregate.
        comments: Number(row?.comments ?? 0),
        flagged: Number(row?.flagged ?? 0),
        hidden: Number(row?.hidden ?? 0),
        lastAt: row?.lastAt ?? null,
        locked: locked.has(session.id),
      };
    });
  }

  private async sessionTitles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const rows = await this.sessions.findByIds(unique);
    return new Map(rows.map((s) => [s.id, s.title]));
  }

  async flagComment(commentId: string, delegateId: string) {
    const comment = await this.comments.findOneBy({
      id: commentId,
    });

    if (!comment) throw new NotFoundException('Comment not found');

    await this.comments.update(commentId, { flagged: true });

    await this.securityService.record({
      type: 'comment_flagged',
      description: 'Discussion comment reported by a delegate',
      actorId: delegateId,
      metadata: { commentId, sessionId: comment.sessionId },
    });
  }

  async hideComment(commentId: string, adminId: string) {
    const comment = await this.comments.findOneBy({
      id: commentId,
    });

    if (!comment) throw new NotFoundException('Comment not found');

    // hidden comments stay in the database for the audit trail (FR-14)
    await this.comments.update(commentId, {
      hiddenAt: new Date(),
      hiddenBy: adminId,
    });

    this.realtime.emitToRoom(
      Rooms.discussion(comment.sessionId),
      'discussion:hidden',
      {
        commentId,
      },
    );
  }

  /**
   * A moderator read a reported comment and decided it stays: the report is
   * cleared, so it leaves the review queue. Without this a reported comment
   * that was fine could only be hidden or left in the queue for good.
   */
  async keepComment(commentId: string): Promise<SessionComment> {
    const comment = await this.comments.findOneBy({ id: commentId });
    if (!comment) throw new NotFoundException('Comment not found');
    await this.comments.update(commentId, { flagged: false });
    return { ...comment, flagged: false };
  }

  /**
   * Undoes a hide made by mistake. The comment is judged fine, so any report
   * on it is cleared too (otherwise it would drop straight back into the
   * review queue), and it is sent to the room again so it reappears on
   * delegates' phones without a refresh.
   */
  async unhideComment(commentId: string): Promise<SessionComment> {
    const comment = await this.comments.findOneBy({ id: commentId });
    if (!comment) throw new NotFoundException('Comment not found');
    if (!comment.hiddenAt) return comment;
    await this.comments.update(commentId, {
      hiddenAt: null,
      hiddenBy: null,
      flagged: false,
    });
    const restored = {
      ...comment,
      hiddenAt: null,
      hiddenBy: null,
      flagged: false,
    };
    await this.emitComment(restored);
    return restored;
  }

  /**
   * Admin view: everything, including hidden $ flagged, for modetation
   */
  listForModeration(sessionId: string) {
    return this.comments.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * A thread with the commenter attached, for the admin export.
   *
   * Moderation only needs the text; a sponsor or partner report needs to know
   * who said it and which segment they belong to, so this joins the delegate's
   * onboarding tracks and interests onto every row. One bulk lookup rather
   * than a join per comment — a thread is read whole.
   *
   * `reaction` is the room's response derived from the vote counters, not a
   * reading of the comment itself: a well-received comment and an agreeable
   * one are different things, and only the first is recorded anywhere.
   */
  async exportThread(sessionId: string) {
    const comments = await this.comments.find({
      where: { sessionId },
      order: { createdAt: 'ASC' }, // reading order, not moderation order
    });

    const authors = await this.delegateService.profilesByIds(
      comments.map((c) => c.authorId),
    );

    return comments.map((c) => {
      const who = authors.get(c.authorId);
      return {
        createdAt: c.createdAt.toISOString(),
        authorName: who?.name ?? 'Deleted delegate',
        authorOrganisation: who?.organisation ?? '',
        authorCountry: who?.country ?? '',
        body: c.body,
        likes: c.likes,
        dislikes: c.dislikes,
        reaction: reactionOf(c.likes, c.dislikes),
        flagged: c.flagged,
        hidden: c.hiddenAt !== null,
        tracks: who?.tracks ?? [],
        interests: who?.interests ?? [],
      };
    });
  }

  /**
   * Raw thread for the post session harvest job (BullMQ phase)
   */
  fullThread(sessionId: string) {
    return this.comments.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
    });
  }
}
