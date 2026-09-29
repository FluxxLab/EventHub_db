import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EditionsService } from '../editions/editions.service';
import { Job, Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { SessionBookmark } from './entities/bookmark.entity';
import { Session, SessionStatus } from './entities/session.entity';

export interface ReminderJob {
  sessionId: string;
  /** The start the reminder was scheduled against, ISO. */
  startsAt: string;
}

/**
 * "Starts in 15 minutes", to everyone who saved the session (FR-04).
 *
 * One delayed job per session, fired by BullMQ fifteen minutes before the
 * start it was scheduled against. Recipients are looked up at fire time, not
 * at scheduling time, so a bookmark added the night before still rings and
 * one removed since does not.
 *
 * The job is a claim about a moment. If the session has since moved, gone
 * live early, or been completed, the claim is stale and nothing is sent: the
 * edit that moved it scheduled a fresh job for the new time.
 */
@Processor('session-reminders')
export class SessionRemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(SessionRemindersProcessor.name);

  constructor(
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(SessionBookmark)
    private readonly bookmarks: Repository<SessionBookmark>,
    @InjectQueue('notifications')
    private readonly notifications: Queue,
    private readonly editions: EditionsService,
  ) {
    super();
  }

  async process(job: Job<ReminderJob>): Promise<void> {
    const { sessionId, startsAt } = job.data;
    const session = await this.sessions.findOneBy({ id: sessionId });
    if (!session) return;
    if (session.status !== SessionStatus.SCHEDULED) return;
    if (Math.abs(session.startsAt.getTime() - Date.parse(startsAt)) > 60_000) {
      this.logger.log(
        `reminder for "${session.title}" skipped: session moved since it was scheduled`,
      );
      return;
    }

    const rows = await this.bookmarks.find({
      where: { sessionId },
      select: { delegateId: true },
    });
    if (rows.length === 0) return;
    // switched off for this edition from the console
    if (await this.editions.isMuted('session-reminder')) return;

    await this.notifications.addBulk(
      rows.map((r) => ({
        name: 'direct',
        data: {
          delegateId: r.delegateId,
          title: session.title,
          body: `Starts in 15 minutes · ${session.room}`,
          category: 'session-reminder',
          sessionId: session.id,
        },
      })),
    );
    this.logger.log(
      `reminder for "${session.title}" -> ${rows.length} delegate(s)`,
    );
  }
}
