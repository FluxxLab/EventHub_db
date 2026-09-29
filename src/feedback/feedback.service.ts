import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { SessionAttendance } from '../sessions/entities/attendance.entity';
import { SessionBookmark } from '../sessions/entities/bookmark.entity';
import { Session } from '../sessions/entities/session.entity';
import { SessionsService } from '../sessions/sessions.service';
import { SubmitFeedbackDto } from './dto/feedback.dto';
import { SessionFeedback } from './entities/session-feedback.entity';

export interface FeedbackView {
  sessionId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export type RatingDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

export interface SessionFeedbackSummary {
  count: number;
  /** Mean rating to two decimals; 0 when nobody has rated. */
  average: number;
  distribution: RatingDistribution;
  comments: { rating: number; comment: string; createdAt: string }[];
}

export interface EditionFeedbackRow {
  sessionId: string;
  title: string;
  count: number;
  /** Null for a session nobody has rated, which sorts after every rated one. */
  average: number | null;
}

/** The notification category the console can mute (edition.mutedNotifications). */
export const FEEDBACK_PROMPT_CATEGORY = 'session-feedback';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The organiser's read of one session, from its rows. Pure and exported so
 * the arithmetic is tested without a database. Comments are only the
 * non-empty ones, newest first: a rating with no words is still a rating,
 * but it is not a comment.
 */
export function summariseFeedback(
  rows: SessionFeedback[],
): SessionFeedbackSummary {
  const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  for (const row of rows) {
    const key = String(row.rating) as keyof RatingDistribution;
    if (key in distribution) distribution[key] += 1;
    total += row.rating;
  }
  const comments = rows
    .filter((r) => r.comment && r.comment.trim().length > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => ({
      rating: r.rating,
      comment: r.comment!.trim(),
      createdAt: r.createdAt.toISOString(),
    }));
  return {
    count: rows.length,
    average: rows.length === 0 ? 0 : round2(total / rows.length),
    distribution,
    comments,
  };
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    @InjectRepository(SessionFeedback)
    private readonly feedback: Repository<SessionFeedback>,
    @InjectRepository(SessionBookmark)
    private readonly bookmarks: Repository<SessionBookmark>,
    @InjectRepository(SessionAttendance)
    private readonly attendance: Repository<SessionAttendance>,
    @InjectRepository(Session)
    private readonly sessionRows: Repository<Session>,
    private readonly sessions: SessionsService,
    // Queued rather than a call into NotificationsService: that service only
    // knows segment broadcasts, and the 'direct' job is how every other
    // module (reminders, connections) reaches one delegate's inbox and phone.
    @InjectQueue('notifications')
    private readonly notifications: Queue,
  ) {}

  /** Upsert: a second rating from the same delegate replaces the first. */
  async submit(
    sessionId: string,
    delegateId: string,
    dto: SubmitFeedbackDto,
  ): Promise<FeedbackView> {
    await this.sessions.findById(sessionId);
    const comment = dto.comment?.trim() || null;

    const existing = await this.feedback.findOne({
      where: { sessionId, delegateId },
    });
    const row = existing
      ? Object.assign(existing, { rating: dto.rating, comment })
      : this.feedback.create({
          sessionId,
          delegateId,
          rating: dto.rating,
          comment,
        });
    return this.toView(await this.feedback.save(row));
  }

  async mine(
    sessionId: string,
    delegateId: string,
  ): Promise<FeedbackView | null> {
    const row = await this.feedback.findOne({
      where: { sessionId, delegateId },
    });
    return row ? this.toView(row) : null;
  }

  async sessionSummary(sessionId: string): Promise<SessionFeedbackSummary> {
    await this.sessions.findById(sessionId);
    return summariseFeedback(
      await this.feedback.find({ where: { sessionId } }),
    );
  }

  /**
   * Every session of an edition with its rating, best first. One aggregate
   * query rather than a summary per session: a programme has a hundred
   * sessions and the console reads the whole table at once.
   */
  async editionSummary(editionId: string): Promise<EditionFeedbackRow[]> {
    const sessions = await this.sessionRows.find({
      where: { editionId },
      select: { id: true, title: true },
    });
    if (sessions.length === 0) return [];

    const aggregates = await this.feedback
      .createQueryBuilder('f')
      .select('f.sessionId', 'sessionId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(f.rating)', 'average')
      .where('f.sessionId IN (:...ids)', { ids: sessions.map((s) => s.id) })
      .groupBy('f.sessionId')
      .getRawMany<{ sessionId: string; count: string; average: string }>();
    const byId = new Map(aggregates.map((a) => [a.sessionId, a]));

    return sessions
      .map((s) => {
        const agg = byId.get(s.id);
        return {
          sessionId: s.id,
          title: s.title,
          // aggregates arrive as strings from a raw query
          count: Number(agg?.count ?? 0),
          average: agg ? round2(Number(agg.average)) : null,
        };
      })
      .sort(
        (a, b) =>
          (b.average ?? -1) - (a.average ?? -1) ||
          b.count - a.count ||
          a.title.localeCompare(b.title),
      );
  }

  /**
   * "How was {title}?" to everyone who was there or meant to be: the
   * delegates who bookmarked the session and the ones recorded in
   * session_attendance, each notified once however many lists they are on.
   *
   * The caller (the session status change) decides whether to send at all -
   * the muted-notifications check lives there, beside the other automatic
   * kinds. Returns how many delegates were queued.
   */
  async promptForSession(sessionId: string): Promise<number> {
    const session = await this.sessions.findById(sessionId);

    const [saved, attended] = await Promise.all([
      this.bookmarks.find({
        where: { sessionId },
        select: { delegateId: true },
      }),
      this.attendance.find({
        where: { sessionId },
        select: { delegateId: true },
      }),
    ]);
    const recipients = new Set<string>([
      ...saved.map((r) => r.delegateId),
      ...attended.map((r) => r.delegateId),
    ]);
    if (recipients.size === 0) return 0;

    await this.notifications.addBulk(
      [...recipients].map((delegateId) => ({
        name: 'direct',
        data: {
          delegateId,
          title: `How was ${session.title}?`,
          body: 'One tap to rate it.',
          category: FEEDBACK_PROMPT_CATEGORY,
          sessionId: session.id,
        },
      })),
    );
    this.logger.log(
      `feedback prompt for "${session.title}" -> ${recipients.size} delegate(s)`,
    );
    return recipients.size;
  }

  /** Bulk lookup for other modules: which of these sessions the delegate has rated. */
  async ratedSessionIds(
    delegateId: string,
    sessionIds: string[],
  ): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    const rows = await this.feedback.find({
      where: { delegateId, sessionId: In(sessionIds) },
      select: { sessionId: true },
    });
    return new Set(rows.map((r) => r.sessionId));
  }

  private toView(row: SessionFeedback): FeedbackView {
    return {
      sessionId: row.sessionId,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
