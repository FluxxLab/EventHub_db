import { CatalogService } from '../catalog/catalog.service';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { ReminderJob } from './session-reminders.processor';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { In, MoreThan, Repository } from 'typeorm';
import { REDIS } from '../common/redis/redis.module';
import { CreateSessionDto } from './dto/create-session.dto';
import { QuerySessionsDto } from './dto/query-sessions.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { SessionBookmark } from './entities/bookmark.entity';
import { SessionAttendance } from './entities/attendance.entity';
import {
  Session,
  SessionStatus,
  SessionTrack,
  type SessionVideoLink,
} from './entities/session.entity';
import { Speaker } from './entities/speaker.entity';
import { SessionComment } from '../discussions/entities/session-comment.entity';
import { TranscriptSegment } from '../captions/entities/transcript-segment.entity';
import { RealtimeService } from '../common/realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AudienceSegment } from '../notifications/entities/notification.entity';
import { EditionsService } from '../editions/editions.service';
import {
  isPlaceholderRoom,
  normaliseSessionType,
  sessionTypeOptions,
} from './session-types';

/** What the programme audit reports; every list is sorted busiest first. */
export interface SessionQualityReport {
  total: number;
  /** Sessions filed under the general track: they show up on no theme filter. */
  generalTrack: { count: number; sessionIds: string[] };
  /** Rooms that are still placeholders, so cannot receive captions. */
  placeholderRooms: { room: string; count: number }[];
  /** Stored `type` values that are not on the canonical list. */
  typeVariants: { type: string; count: number }[];
  withoutSpeakers: { count: number };
}

@Injectable()
export class SessionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,

    @InjectRepository(Speaker)
    private readonly speakers: Repository<Speaker>,

    @InjectRepository(SessionBookmark)
    private readonly bookmarks: Repository<SessionBookmark>,

    @InjectRepository(SessionAttendance)
    private readonly attendance: Repository<SessionAttendance>,

    @InjectRepository(SessionComment)
    private readonly comments: Repository<SessionComment>,

    @InjectRepository(TranscriptSegment)
    private readonly transcripts: Repository<TranscriptSegment>,

    private readonly realtime: RealtimeService,

    @Inject(REDIS)
    private readonly redis: Redis,

    private readonly notifications: NotificationsService,

    @InjectQueue('session-reminders')
    private readonly reminders: Queue<ReminderJob>,

    private readonly editions: EditionsService,
    /**
     * Per-delegate pushes ("How was this session?"). Optional so the unit
     * specs, which build the service by hand, need not supply a queue.
     */
    @InjectQueue('notifications')
    private readonly directNotifications?: Queue,
    /** Checks a session's track against its edition's. Optional for the hand-built specs. */
    private readonly catalog?: CatalogService,
  ) {}

  /* ------------------------------------------------- edition scoping */

  /**
   * The summit every browse surface is limited to.
   *
   * Null means no edition is current, which is what a database looks like
   * before the Editions migration runs. Callers then fall back to querying
   * everything, exactly as they did before editions existed: a
   * misconfiguration should degrade to the old behaviour, never to a summit
   * that appears to have no programme at all.
   *
   * Deliberately NOT applied to lookups by id (findById, findByIds,
   * recordAttendance) - a session id is already unambiguous, and a delegate
   * following a link to last year's session should reach it rather than a
   * 404. Also not applied to the speaker directory, which has no edition of
   * its own yet; that needs speakers to be linked through sessions and is its
   * own change. savedSessions is left alone for the same reason: a delegate's
   * bookmarks are a personal collection, and silently emptying it is worse
   * than showing one from a summit that has finished.
   */
  private async currentEditionId(): Promise<string | null> {
    const edition = await this.editions.current(true);
    return edition?.id ?? null;
  }

  /** Spreadable into a `find` where-clause; empty when nothing is current. */
  private async editionWhere(): Promise<{ editionId?: string }> {
    const editionId = await this.currentEditionId();
    return editionId ? { editionId } : {};
  }

  /* --------------------------------------------- saved-session reminders (FR-04) */

  static readonly REMINDER_LEAD_MS = 15 * 60_000;

  /**
   * One delayed job per session, keyed by the session id so scheduling again
   * replaces rather than duplicates. Anything not scheduled - live already,
   * completed - or starting within the lead time gets no job. Callers fire
   * and forget: a reminder that cannot be queued must not fail the edit.
   */
  private async scheduleReminder(s: Session): Promise<void> {
    const jobId = `reminder-${s.id}`;
    await this.reminders.remove(jobId);
    const delay =
      s.startsAt.getTime() - SessionsService.REMINDER_LEAD_MS - Date.now();
    if (s.status !== SessionStatus.SCHEDULED || delay <= 0) return;
    await this.reminders.add(
      'remind',
      { sessionId: s.id, startsAt: s.startsAt.toISOString() },
      { jobId, delay, removeOnComplete: true, removeOnFail: true },
    );
  }

  private remind(...sessions: Session[]): void {
    for (const s of sessions) {
      void this.scheduleReminder(s).catch((e) =>
        this.logger.warn(`reminder not scheduled for "${s.title}": ${e}`),
      );
    }
  }

  private cancelReminder(id: string): void {
    void this.reminders
      .remove(`reminder-${id}`)
      .catch((e) => this.logger.warn(`reminder not cancelled for ${id}: ${e}`));
  }

  /**
   * Sessions that existed before this instance came up have no job yet, and
   * Redis may have been flushed. Re-issuing for every upcoming session is
   * idempotent thanks to the fixed job id, so it is safe on every boot and on
   * every instance.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const upcoming = await this.sessions.find({
        where: {
          status: SessionStatus.SCHEDULED,
          startsAt: MoreThan(new Date()),
        },
      });
      await Promise.all(upcoming.map((s) => this.scheduleReminder(s)));
      this.logger.log(`reminders scheduled for ${upcoming.length} session(s)`);
    } catch (e) {
      this.logger.warn(`reminders not rescheduled on boot: ${e}`);
    }
  }

  /* --------------------------------------------- delegate notifications (FR-08) */

  /**
   * Every change to the programme goes to every delegate as a push, and lands
   * in their inbox. Queued through the notifications module, never awaited:
   * the push goes out from the worker, and a failure to queue it must not
   * fail the edit the operator just made.
   */
  /**
   * A notification about a session carries the session, so a tap opens it.
   * Without the id the app has nothing to open and the row is dead text -
   * which is how "Now live in Main Hall" shipped for the whole summit.
   */
  private broadcast(
    title: string,
    body: string,
    category: string,
    sessionId?: string,
  ): void {
    void this.announceUnlessMuted(title, body, category, sessionId);
  }

  /**
   * An organiser can switch any automatic push off per edition. Checked here,
   * at the one place the sessions module announces, so a new call site cannot
   * forget. Muted is the quiet outcome: nothing is queued and nothing is
   * logged as a failure, because nothing failed.
   */
  private async announceUnlessMuted(
    title: string,
    body: string,
    category: string,
    sessionId?: string,
  ): Promise<void> {
    if (await this.editions.isMuted(category)) return;
    await this.notifications
      .announce({
        title,
        body,
        segment: AudienceSegment.ALL,
        category,
        sessionId,
      })
      .catch((e) =>
        this.logger.warn(`push not queued for "${title}" (${category}): ${e}`),
      );
  }

  private static readonly whenFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  private static readonly timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  /** "Tue 8 Sept 09:00–10:00 · Main Hall", in summit time. */
  private static slot(s: Session): string {
    return `${SessionsService.whenFmt.format(s.startsAt)} ${SessionsService.timeFmt.format(s.startsAt)}–${SessionsService.timeFmt.format(s.endsAt)} · ${s.room}`;
  }

  /* --------------------------------------------- speaker reveal (FR-02/03) */

  /**
   * One global switch, off until the organisers throw it: while it is off no
   * delegate surface gives up a speaker's name, role, organisation or photo.
   *
   * Redis rather than a column because it is operational state, not program
   * data - it survives a restart, is shared across API instances, and flipping
   * it is a one-key write on the day rather than a migration.
   */
  private static readonly REVEAL_KEY = 'summit:speakers:revealed';

  /** What a delegate sees in a speaker's place before the reveal. */
  static readonly HIDDEN_SPEAKER_NAME = 'To be announced';

  async speakersRevealed(): Promise<boolean> {
    return (await this.redis.get(SessionsService.REVEAL_KEY)) === '1';
  }

  async setSpeakersRevealed(revealed: boolean): Promise<{ revealed: boolean }> {
    await this.redis.set(SessionsService.REVEAL_KEY, revealed ? '1' : '0');
    // Global, not per-session: the flag is the whole program's, and a delegate
    // sitting on any screen should see the line-up appear without relaunching.
    this.realtime.emitGlobal('speakers:revealed', { revealed });
    if (revealed) {
      this.broadcast(
        'Speakers announced',
        'The full speaker line-up is now in the app.',
        'speakers-revealed',
      );
    }
    return { revealed };
  }

  /**
   * True when this caller must not be shown speaker identities. Admin is
   * exempt - they are the ones building the line-up.
   */
  private async mustHideSpeakers(isAdmin: boolean): Promise<boolean> {
    if (isAdmin) return false;
    return !(await this.speakersRevealed());
  }

  /**
   * The single placeholder a session's whole line-up collapses into.
   *
   * One entry, never one per speaker: redacting each speaker in place would
   * still publish how many there are, and "four speakers, all to be announced"
   * on a panel is a fact about the line-up we are meant to be withholding. The
   * id is a sentinel rather than a real speaker's - there is no row behind it.
   */
  static readonly HIDDEN_SPEAKER_ID = 'tba';

  hiddenSpeaker(): Speaker {
    return {
      id: SessionsService.HIDDEN_SPEAKER_ID,
      name: SessionsService.HIDDEN_SPEAKER_NAME,
      role: null,
      organisation: null,
      avatarUrl: null,
    };
  }

  /**
   * True when this caller must not be shown speaker identities.
   *
   * Redaction itself is not done here any more - SpeakerRevealInterceptor
   * applies it to every HTTP response, so a new endpoint is covered without
   * anyone remembering to call anything. This stays for the two decisions the
   * interceptor cannot make: whether a speaker-only listing returns rows at
   * all, and whether a query may match on speaker columns.
   */
  async mustHideSpeakersFor(isAdmin: boolean): Promise<boolean> {
    return this.mustHideSpeakers(isAdmin);
  }

  /**
   * What sessions can be filed under: the edition's tracks (the current one
   * unless named), then the general bucket. Labels come with them, so every
   * client names tracks alike.
   */
  async tracks(
    editionId?: string,
  ): Promise<{ value: string; label: string; hint: string }[]> {
    return this.catalog ? this.catalog.sessionTracks(editionId) : [];
  }

  /** The closed list of session types with labels; see session-types.ts. */
  types(): { value: string; label: string }[] {
    return sessionTypeOptions();
  }

  /**
   * The programme audit. One fetch of the edition's sessions and everything
   * is counted here: an edition is a hundred rows, and the four questions
   * share the same rows, so four GROUP BYs would be more code for a slower
   * answer. Type variants are anything the normaliser would change,
   * including values it cannot place at all - after the NormaliseSessionTypes
   * migration this list is empty until someone writes past the DTO.
   */
  async quality(editionId?: string): Promise<SessionQualityReport> {
    const rows = await this.sessions.find({
      where: editionId ? { editionId } : await this.editionWhere(),
      relations: { speakers: true },
      select: {
        id: true,
        track: true,
        room: true,
        type: true,
        speakers: { id: true },
      },
    });

    const general = rows.filter((s) => s.track === SessionTrack.GENERAL);
    const rooms = new Map<string, number>();
    const types = new Map<string, number>();
    for (const s of rows) {
      if (isPlaceholderRoom(s.room)) {
        rooms.set(s.room, (rooms.get(s.room) ?? 0) + 1);
      }
      if (normaliseSessionType(s.type) !== s.type) {
        types.set(s.type, (types.get(s.type) ?? 0) + 1);
      }
    }
    const byCount = <T extends { count: number }>(a: T, b: T) =>
      b.count - a.count;

    return {
      total: rows.length,
      generalTrack: {
        count: general.length,
        sessionIds: general.map((s) => s.id),
      },
      placeholderRooms: [...rooms]
        .map(([room, count]) => ({ room, count }))
        .sort(byCount),
      typeVariants: [...types]
        .map(([type, count]) => ({ type, count }))
        .sort(byCount),
      withoutSpeakers: {
        count: rows.filter((s) => (s.speakers?.length ?? 0) === 0).length,
      },
    };
  }

  async list(query: QuerySessionsDto) {
    return this.sessions.find({
      where: {
        ...(query.editionId
          ? { editionId: query.editionId }
          : await this.editionWhere()),
        ...(query.day !== undefined && { day: query.day }),
        ...(query.track !== undefined && { track: query.track }),
        ...(query.status !== undefined && { status: query.status }),
      },
      relations: { speakers: true },
      order: { startsAt: 'ASC' },
    });
  }

  async findLiveNow(): Promise<Session[]> {
    /**
     * Functional requirment 1  "live" is Operation-set status,
     * not clock math
     */
    return this.sessions.find({
      where: {
        ...(await this.editionWhere()),
        status: SessionStatus.LIVE,
      },
      relations: {
        speakers: true,
      },
    });
  }

  /**
   * The venue board: what every room is doing, for a public screen.
   *
   * Public and unauthenticated, so it carries only what a departures board
   * needs - title, room, times, status, and the line-up. Speaker names go
   * through SpeakerRevealInterceptor like every other response, so before the
   * reveal a screen shows "To be announced" and not the withheld line-up.
   *
   * Everything comes back rather than "today": the screen decides what is
   * live, next and later from the clock, and the operator-set status, and a
   * day boundary in Abuja is not one the server should be guessing at.
   */
  async board(): Promise<Session[]> {
    return this.sessions.find({
      where: await this.editionWhere(),
      select: {
        id: true,
        title: true,
        day: true,
        startsAt: true,
        endsAt: true,
        room: true,
        track: true,
        type: true,
        status: true,
        speakers: { id: true, name: true, role: true, organisation: true },
      },
      relations: { speakers: true },
      order: { startsAt: 'ASC' },
    });
  }

  /**
   * Room -> live session, remembered for a few seconds.
   *
   * The caption pipeline asks this for every Deepgram fragment - several a
   * second per room, ten rooms at once - and the answer only changes when an
   * operator flips a session's status. Cached per instance: this instance
   * forgets everything the moment it changes a status itself (setStatus), and
   * a change made on another API instance is picked up within LIVE_ROOM_TTL_MS.
   * A few seconds of captions attaching to the session that just ended, or
   * waiting to attach to the one that just started, is the accepted cost.
   * Misses (nothing live - a break) are cached too; they are the common case
   * between sessions and just as hot.
   */
  private static readonly LIVE_ROOM_TTL_MS = 5_000;
  private readonly liveRoomCache = new Map<
    string,
    { at: number; session: Promise<Session | null> }
  >();

  /** Drop every cached room -> live session answer on this instance. */
  invalidateLiveRooms(): void {
    this.liveRoomCache.clear();
  }

  /**
   * `fresh` skips the cache (and refills it). Captions use it to decide when
   * to open and close a room's transcription: the cache is only invalidated
   * on the replica that changed the status, so another replica could keep
   * paying for a finished session, or miss a new one, for its whole TTL.
   */
  findLiveInRoom(room: string, fresh = false): Promise<Session | null> {
    const key = room.trim().toLowerCase();
    const now = Date.now();
    const hit = this.liveRoomCache.get(key);
    if (!fresh && hit && now - hit.at < SessionsService.LIVE_ROOM_TTL_MS) {
      return hit.session;
    }
    // The promise is cached, not the value, so a burst of fragments arriving
    // on a cold cache shares one query instead of racing several.
    const session = this.queryLiveInRoom(room);
    this.liveRoomCache.set(key, { at: now, session });
    // A failed lookup must not be remembered for five seconds.
    session.catch(() => {
      if (this.liveRoomCache.get(key)?.session === session) {
        this.liveRoomCache.delete(key);
      }
    });
    return session;
  }

  private async queryLiveInRoom(room: string): Promise<Session | null> {
    /**
     * Matched loosely on purpose. The capture page sends whichever room string
     * the operator picked, and an exact match means one stray space or a
     * different capitalisation silently drops every caption for the session,
     * with no error raised anywhere to explain it.
     */
    // Scoped, because room names repeat between summits: "Main Hall" exists
    // in every edition, and captions attaching to last year's session would
    // be silent and very hard to explain.
    const editionId = await this.currentEditionId();
    const qb = this.sessions
      .createQueryBuilder('s')
      .where('LOWER(TRIM(s.room)) = LOWER(TRIM(:room))', { room })
      .andWhere('s.status = :status', { status: SessionStatus.LIVE });
    if (editionId) qb.andWhere('s.editionId = :editionId', { editionId });
    return qb.getOne();
  }

  /**
   * Bulk lookup for surfaces that render many sessions' titles at once, such
   * as cross-session comment moderation. One query instead of one per row.
   */
  findByIds(ids: string[]): Promise<Session[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.sessions.find({ where: { id: In(ids) } });
  }

  async findById(id: string): Promise<Session> {
    const session = await this.sessions.findOne({
      where: {
        id,
      },
      relations: { speakers: true },
    });

    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  /**
   * One list of recordings from whichever shape the client sent.
   *
   * A new console sends `videos`; the console and app already deployed send
   * only `videoUrl`. Both are honoured, and the single field is always
   * derived from the list afterwards, so the two can never disagree about
   * which recording is "the" recording.
   */
  private static normaliseVideos(dto: {
    videos?: { url: string; title?: string }[];
    videoUrl?: string;
  }): SessionVideoLink[] | undefined {
    if (dto.videos !== undefined) {
      return dto.videos
        .map((v) => ({
          url: v.url.trim(),
          ...(v.title?.trim() ? { title: v.title.trim() } : {}),
        }))
        .filter((v) => v.url.length > 0);
    }
    if (dto.videoUrl !== undefined) {
      const url = dto.videoUrl.trim();
      return url ? [{ url }] : [];
    }
    return undefined;
  }

  async create(dto: CreateSessionDto, announce = true): Promise<Session> {
    const { speakerIds, videoUrl, editionId, ...data } = dto;
    const videoList = SessionsService.normaliseVideos(dto) ?? [];
    // Named explicitly when the console is building a future programme;
    // otherwise this session belongs to the summit now running.
    const forEdition = editionId ?? (await this.currentEditionId());
    await this.catalog?.assertSessionTrack(data.track, forEdition);
    const session = this.sessions.create({
      ...data,
      editionId: forEdition,
      videos: videoList,
      // kept in step with the first recording for the app build already shipped
      videoUrl: videoList[0]?.url ?? (videoUrl?.trim() || null),
      startsAt: new Date(dto.startsAt),
      endsAt: new Date(dto.endsAt),
      speakers: speakerIds?.length
        ? await this.speakers.findBy({
            id: In(speakerIds),
          })
        : [],
    });
    const saved = await this.sessions.save(session);
    // Every schedule on screen refetches: the delegate agenda, the venue
    // board, and any other console tab.
    this.invalidateLiveRooms();
    this.realtime.emitGlobal('session:created', { sessionId: saved.id });
    this.remind(saved);
    if (announce) {
      this.broadcast(
        saved.title,
        `Added to the programme · ${SessionsService.slot(saved)}`,
        'session-created',
        saved.id,
      );
    }
    return saved;
  }

  /**
   * One push for the whole batch, not one per row: an agenda import is sixty
   * sessions, and sixty buzzes teaches a delegate to switch notifications off
   * before the summit starts.
   */
  async createBulk(dtos: CreateSessionDto[]): Promise<Session[]> {
    const created = await Promise.all(
      dtos.map((dto) => this.create(dto, false)),
    );
    if (created.length > 0) {
      this.broadcast(
        'Programme updated',
        `${created.length} session${created.length === 1 ? '' : 's'} added. Check your agenda.`,
        'session-created',
      );
    }
    return created;
  }

  async update(id: string, dto: UpdateSessionDto): Promise<Session> {
    const session = await this.findById(id);
    const { speakerIds, startsAt, endsAt, status, shiftFollowing, ...data } =
      dto;
    if (data.track !== undefined && data.track !== session.track) {
      await this.catalog?.assertSessionTrack(data.track, session.editionId);
    }
    Object.assign(session, data);

    // sent when touched, absent when not - only a sent value may wipe the
    // stored recordings, and the single field always follows the list
    const videoList = SessionsService.normaliseVideos(dto);
    if (videoList !== undefined) {
      session.videos = videoList;
      session.videoUrl = videoList[0]?.url ?? null;
    }

    if (startsAt) session.startsAt = new Date(startsAt);
    if (endsAt) session.endsAt = new Date(endsAt);
    if (speakerIds) {
      session.speakers = speakerIds.length
        ? await this.speakers.findBy({ id: In(speakerIds) })
        : [];
    }

    // Anything that changes where or when this session sits has to leave
    // the room's timeline free of overlaps. Planned before the write so a
    // refused edit leaves nothing half-applied.
    const placed =
      startsAt !== undefined ||
      endsAt !== undefined ||
      data.room !== undefined ||
      data.day !== undefined;
    const { pushed, deltaMs } = placed
      ? await this.clearRoom(session, shiftFollowing ?? true)
      : { pushed: [], deltaMs: 0 };

    const saved = await this.sessions.save(session);

    if (pushed.length > 0) {
      await this.sessions.save(pushed);
      // Every client showing a schedule needs to refetch: the delegate app's
      // agenda, the venue board, and any other console tab.
      this.realtime.emitGlobal('sessions:shifted', {
        room: saved.room,
        day: saved.day,
        deltaMinutes: Math.round(deltaMs / 60_000),
        sessionIds: [saved.id, ...pushed.map((s) => s.id)],
      });
      this.logger.log(
        `${saved.room}: pushed ${pushed.length} session(s) after "${saved.title}" to clear an overlap`,
      );
    }

    // A plain edit - a new time, room or title - has to reach every screen
    // too, not only the ones that involved a push.
    // a room rename or a moved slot changes which session a capture room maps to
    this.invalidateLiveRooms();
    this.realtime.emitGlobal('session:updated', { sessionId: saved.id });

    // Delegates hear about a session moving, theirs or one it pushed. A
    // retitled description is not worth a buzz.
    if (placed) {
      this.remind(saved, ...pushed);
      this.broadcast(
        saved.title,
        `Schedule change · ${SessionsService.slot(saved)}`,
        'session-updated',
        saved.id,
      );
      for (const s of pushed) {
        this.broadcast(
          s.title,
          `Schedule change · ${SessionsService.slot(s)}`,
          'session-updated',
          s.id,
        );
      }
    }

    // status is a transition, not a field write — reuse the one path
    // that emits to the room and trips the audit interceptor
    return status && status !== session.status
      ? this.setStatus(id, status)
      : saved;
  }

  /**
   * One room holds one session at a time. Given a session with its new
   * times already applied, work out what the rest of that room and day has
   * to do about it.
   *
   * Sessions after it are walked in start order, each one pushed just far
   * enough to start when the one before it ends - and no further, so a gap
   * the programme left is kept unless the delay needs it. The push cascades:
   * a session moved into the next one moves that one too. Durations are
   * never changed. Completed sessions are left alone - they already
   * happened. Room is matched loosely, the way the capture page does, so a
   * stray space in a room name cannot split a room into two timelines.
   *
   * Pushing is the default: an operator who moves a session wants the room
   * to make sense afterwards, not an error. `push` false refuses a collision
   * (409) naming the session in the way, for a caller that would rather
   * know than have the rest of the day moved.
   * A collision with an *earlier* session is always refused: the edited
   * session is what the operator just typed, and the one before it cannot
   * be moved later without landing on top of it.
   *
   * Returns the sessions that moved, with their new times set but not yet
   * saved, so the caller can write them in the same breath as the edit, and
   * the largest push applied, for the log and the shifted event.
   */
  private async clearRoom(
    edited: Session,
    push: boolean,
  ): Promise<{ pushed: Session[]; deltaMs: number }> {
    const others = await this.sessions
      .createQueryBuilder('s')
      .where('LOWER(TRIM(s.room)) = LOWER(TRIM(:room))', { room: edited.room })
      .andWhere('s.day = :day', { day: edited.day })
      .andWhere('s.id <> :id', { id: edited.id })
      .andWhere('s.status <> :done', { done: SessionStatus.COMPLETED })
      .orderBy('s."startsAt"', 'ASC')
      .getMany();

    const start = edited.startsAt.getTime();
    const hhmm = (d: Date) =>
      d.toLocaleTimeString('en-GB', {
        timeZone: 'Africa/Lagos',
        hour: '2-digit',
        minute: '2-digit',
      });

    const before = others.find(
      (s) => s.startsAt.getTime() < start && s.endsAt.getTime() > start,
    );
    if (before) {
      throw new ConflictException(
        `"${edited.title}" would start before "${before.title}" ends at ${hhmm(before.endsAt)} in ${edited.room}. Move that session first.`,
      );
    }

    const pushed: Session[] = [];
    let deltaMs = 0;
    let prevEnd = edited.endsAt.getTime();
    for (const s of others.filter((o) => o.startsAt.getTime() >= start)) {
      if (s.startsAt.getTime() < prevEnd) {
        if (!push) {
          throw new ConflictException(
            `"${edited.title}" would overlap "${s.title}" (${hhmm(s.startsAt)}–${hhmm(s.endsAt)}) in ${edited.room}. Shorten it, or shift the sessions that follow.`,
          );
        }
        const delta = prevEnd - s.startsAt.getTime();
        s.startsAt = new Date(s.startsAt.getTime() + delta);
        s.endsAt = new Date(s.endsAt.getTime() + delta);
        pushed.push(s);
        deltaMs = Math.max(deltaMs, delta);
      }
      prevEnd = s.endsAt.getTime();
    }
    return { pushed, deltaMs };
  }

  /**
   * "How was {title}?" to everyone who bookmarked or attended the session,
   * once it is over. GS-26 produced no evaluation data at all; one rating and
   * one optional sentence is the cheapest instrument there is and it feeds
   * straight into programming the next summit. Same 'direct' job the
   * 15-minute reminder uses, so the inbox row and the push come from one
   * path. Muted per edition like the other automatic notifications.
   */
  private async promptFeedback(session: Session): Promise<void> {
    if (!this.directNotifications) return;
    if (await this.editions.isMuted('session-feedback')) return;
    const [bookmarked, attended] = await Promise.all([
      this.bookmarks.find({
        where: { sessionId: session.id },
        select: { delegateId: true },
      }),
      this.attendance.find({
        where: { sessionId: session.id },
        select: { delegateId: true },
      }),
    ]);
    const delegateIds = new Set(
      [...bookmarked, ...attended].map((row) => row.delegateId),
    );
    if (delegateIds.size === 0) return;
    await this.directNotifications.addBulk(
      [...delegateIds].map((delegateId) => ({
        name: 'direct',
        data: {
          delegateId,
          title: `How was ${session.title}?`,
          body: 'One tap to rate it.',
          category: 'session-feedback',
          sessionId: session.id,
        },
      })),
    );
  }

  async setStatus(id: string, status: SessionStatus): Promise<Session> {
    const session = await this.findById(id);
    const wentLive =
      status === SessionStatus.LIVE && session.status !== SessionStatus.LIVE;
    const wentOver =
      status === SessionStatus.COMPLETED &&
      session.status !== SessionStatus.COMPLETED;
    session.status = status;

    const saved = await this.sessions.save(session);

    // Going live is the one status change delegates with the app closed
    // need to hear about (FR-08). Everyone gets it - the organisers asked
    // for a broadcast, not a bookmark-only nudge. Queued, not awaited: the
    // push goes out from the worker, and a failure to queue it must not
    // fail the status change the operator just made.
    if (wentLive) {
      this.broadcast(
        saved.title,
        `Now live in ${saved.room}`,
        'session-live',
        saved.id,
      );
    }
    // One-tap feedback lands the moment the session ends (post-summit
    // report, XV.4). Fire and forget for the same reason as the live push.
    if (wentOver) {
      void this.promptFeedback(saved).catch((e) =>
        this.logger.warn(`feedback prompt not queued for ${saved.id}: ${e}`),
      );
    }
    // a session that is live or over no longer "starts in 15 minutes"
    if (status !== SessionStatus.SCHEDULED) this.cancelReminder(id);
    else this.remind(saved);

    // Captions look the room's live session up through a short cache; this
    // instance's copy must not outlive the change it just made.
    this.invalidateLiveRooms();

    /**
     * Once, globally. It used to go to the session room as well, so every
     * delegate with that session open received it twice. The app maps the
     * global event onto both the session page and the session lists, so the
     * room emit added nothing but a duplicate.
     */
    this.realtime.emitGlobal('session:status', {
      sessionId: id,
      status,
      at: new Date().toISOString(),
    });

    return saved;
  }

  /**
   * Delete a session and everything hanging off it.
   *
   * Only `session_speakers` has a foreign key back to sessions (ON DELETE
   * CASCADE); bookmarks, attendance, comments and transcript segments all
   * carry a plain sessionId column, so they have to be cleared here or they
   * become orphans that still count towards certificates and still surface in
   * delegates' saved lists.
   *
   * Anything a delegate actually did - attended, commented - and the session's
   * transcript are real records, so removing a session that has them needs
   * `force`. The refusal names what would be destroyed rather than making the
   * organiser guess.
   */
  async remove(id: string, force = false): Promise<void> {
    const session = await this.findById(id); // 404s if it is already gone

    // Questions, feedback, materials and polls live in their own modules and
    // are not deleted here, so a session holding any of them is refused even
    // with force: deleting it would leave them pointing at nothing.
    const kept = await this.keptRecords(id);
    if (kept.length) {
      throw new ConflictException(
        `"${session.title}" has ${kept.join(', ')}. Remove those first, or leave the session in the programme.`,
      );
    }

    const [attendance, comments, transcripts, bookmarks] = await Promise.all([
      this.attendance.countBy({ sessionId: id }),
      this.comments.countBy({ sessionId: id }),
      this.transcripts.countBy({ sessionId: id }),
      this.bookmarks.countBy({ sessionId: id }),
    ]);

    if (!force && (attendance || comments || transcripts)) {
      const parts = [
        attendance && `${attendance} attendance record(s)`,
        comments && `${comments} comment(s)`,
        transcripts && `${transcripts} caption line(s)`,
        bookmarks && `${bookmarks} bookmark(s)`,
      ].filter(Boolean);
      throw new ConflictException(
        `"${session.title}" has ${parts.join(', ')}. Deleting removes them permanently.`,
      );
    }

    await this.bookmarks.delete({ sessionId: id });
    await this.attendance.delete({ sessionId: id });
    await this.comments.delete({ sessionId: id });
    await this.transcripts.delete({ sessionId: id });
    await this.sessions.delete({ id });

    // global, not the session room: a delegate looking at the programme is not
    // in that room, and their agenda has to lose the session too
    this.invalidateLiveRooms();
    this.realtime.emitGlobal('session:deleted', { sessionId: id });
    this.cancelReminder(id);
    // No push for a deletion. Most deletions are housekeeping - test rows,
    // duplicates from an import - and a "cancelled" buzz for those would
    // only alarm people. A real cancellation is announced by hand.
  }

  /** Records in other modules that name this session; see `remove`. */
  private async keptRecords(id: string): Promise<string[]> {
    const rows: Record<string, number | string>[] = await this.sessions.query(
      `SELECT
         (SELECT COUNT(*) FROM "session_questions" WHERE "sessionId" = $1)::int AS questions,
         (SELECT COUNT(*) FROM "session_feedback" WHERE "sessionId" = $1)::int AS feedback,
         (SELECT COUNT(*) FROM "session_materials" WHERE "sessionId" = $1)::int AS materials,
         (SELECT COUNT(*) FROM "polls" WHERE "sessionId" = $1)::int AS polls`,
      [id],
    );
    const row = rows?.[0] ?? {};
    const n = (key: string) => Number(row[key] ?? 0);
    return [
      n('questions') && `${n('questions')} question(s)`,
      n('feedback') && `${n('feedback')} feedback response(s)`,
      n('materials') && `${n('materials')} material(s)`,
      n('polls') && `${n('polls')} poll(s)`,
    ].filter((x): x is string => !!x);
  }

  /**
   * Delete a batch. Each session is judged on its own: the ones without
   * activity go, and the ones the single-delete rule would refuse are
   * reported together in one 409 naming each, so the operator can retry the
   * batch with `force` knowing exactly what that destroys. A session that
   * is already gone is skipped rather than failing the batch, which is what
   * makes that retry safe.
   */
  async removeMany(ids: string[], force = false): Promise<void> {
    const refused: string[] = [];
    for (const id of ids) {
      try {
        await this.remove(id, force);
      } catch (e) {
        if (e instanceof NotFoundException) continue;
        if (e instanceof ConflictException) {
          refused.push(e.message);
          continue;
        }
        throw e;
      }
    }
    if (refused.length > 0) {
      throw new ConflictException(
        `${refused.length} of ${ids.length} not deleted. ${refused.join(' ')}`,
      );
    }
  }

  async bookmark(delegateId: string, sessionId: string): Promise<void> {
    await this.findById(sessionId); // 404s before the insert if the session is unknown
    await this.bookmarks
      .createQueryBuilder()
      .insert()
      // createdAt set explicitly: a query-builder insert bypasses entity
      // hooks, and the column was created NOT NULL without a default
      .values({ delegateId, sessionId, createdAt: new Date() })
      .orIgnore()
      .execute();
  }

  async unbookmark(delegateId: string, sessionId: string): Promise<void> {
    await this.bookmarks.delete({ delegateId, sessionId });
  }

  async savedSessions(delegateId: string): Promise<Session[]> {
    const rows = await this.bookmarks.find({
      where: { delegateId },
    });
    if (!rows.length) return [];
    return this.sessions.find({
      where: { id: In(rows.map((r) => r.sessionId)) },
      relations: { speakers: true },
      order: { startsAt: 'ASC' },
    });
  }

  async searchSessions(
    q: string,
    limit: number = 10,
    isAdmin = false,
  ): Promise<Session[]> {
    const hide = await this.mustHideSpeakers(isAdmin);
    const editionId = await this.currentEditionId();
    const qb = this.sessions
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.speakers', 'sp') // ← missing line; creates the `sp` alias
      // While speakers are hidden the speaker columns drop out of the WHERE
      // too: matching a session on its speaker's role would let a delegate
      // find out who is on it by guessing, which is the thing being withheld.
      .where(
        hide
          ? '(s.title ILIKE :q OR s.description ILIKE :q)'
          : '(s.title ILIKE :q OR s.description ILIKE :q OR sp.role ILIKE :q)',
        { q: `%${q}%` },
      )
      .take(limit);
    // Bracketed above so this AND binds against the whole OR group rather
    // than only its last branch.
    if (editionId) qb.andWhere('s.editionId = :editionId', { editionId });
    const rows = await qb.getMany();
    // The joined speakers are redacted by SpeakerRevealInterceptor on the way
    // out; what has to happen here is the WHERE, which it cannot reach.
    return rows;
  }

  /**
   * Before the reveal this returns nothing at all rather than placeholders:
   * the query itself is the leak. Searching a name and getting one "To be
   * announced" back confirms that person is speaking.
   */
  async searchSpeakers(
    q: string,
    limit: number,
    isAdmin = false,
  ): Promise<Speaker[]> {
    if (await this.mustHideSpeakers(isAdmin)) return [];
    return this.speakers
      .createQueryBuilder('s')
      .where('s.name ILIKE :q OR s.organisation ILIKE :q OR s.role ILIKE :q', {
        q: `%${q}%`,
      })
      .take(limit)
      .getMany();
  }

  async statusCounts() {
    const where = await this.editionWhere();
    const [live, scheduled, completed] = await Promise.all([
      this.sessions.countBy({ ...where, status: SessionStatus.LIVE }),
      this.sessions.countBy({ ...where, status: SessionStatus.SCHEDULED }),
      this.sessions.countBy({ ...where, status: SessionStatus.COMPLETED }),
    ]);
    return { live, scheduled, completed };
  }

  /** Empty for delegates before the reveal - see searchSpeakers. */
  async listSpeakers(isAdmin = false): Promise<Speaker[]> {
    if (await this.mustHideSpeakers(isAdmin)) return [];
    return this.speakers.find({ order: { name: 'ASC' } });
  }

  createSpeaker(dto: Partial<Speaker>): Promise<Speaker> {
    return this.speakers.save(this.speakers.create(dto));
  }

  /** Edit a speaker's name, role, organisation or photo. Speakers are shared, so every event that lists them sees the change. */
  async updateSpeaker(id: string, dto: Partial<Speaker>): Promise<Speaker> {
    const speaker = await this.speakers.findOneBy({ id });
    if (!speaker) throw new NotFoundException('Speaker not found');
    Object.assign(speaker, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.role !== undefined && { role: dto.role?.trim() || null }),
      ...(dto.organisation !== undefined && {
        organisation: dto.organisation?.trim() || null,
      }),
      ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl || null }),
    });
    const saved = await this.speakers.save(speaker);
    this.invalidateLiveRooms();
    return saved;
  }

  /**
   * Delete a speaker who is on no session. The join table cascades, so a
   * delete would otherwise take them off every session in every event
   * without a word; the refusal names a few of those sessions instead.
   */
  async removeSpeaker(id: string): Promise<void> {
    const speaker = await this.speakers.findOneBy({ id });
    if (!speaker) throw new NotFoundException('Speaker not found');
    const on: { title: string }[] = await this.speakers.query(
      `SELECT s.title FROM "session_speakers" ss
         JOIN "sessions" s ON s.id = ss."sessionsId"
        WHERE ss."speakersId" = $1
        ORDER BY s."startsAt"`,
      [id],
    );
    if (on.length) {
      const named = on
        .slice(0, 3)
        .map((s) => `"${s.title}"`)
        .join(', ');
      const more = on.length > 3 ? ` and ${on.length - 3} more` : '';
      throw new ConflictException(
        `${speaker.name} speaks at ${on.length === 1 ? 'a session' : `${on.length} sessions`} (${named}${more}). Take them off first.`,
      );
    }
    await this.speakers.delete({ id });
  }

  // Attendance is only recorded while a session is LIVE: opening the page for a
  // scheduled or finished session is browsing, not participation. Idempotent -
  // the unique (delegateId, sessionId) index makes a repeat join a no-op.
  async recordAttendance(delegateId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findOneBy({ id: sessionId });
    if (!session || session.status !== SessionStatus.LIVE) return;

    await this.attendance
      .createQueryBuilder()
      .insert()
      .into(SessionAttendance)
      .values({ delegateId, sessionId })
      .orIgnore()
      .execute();
  }

  hasAttended(delegateId: string): Promise<boolean> {
    return this.attendance.existsBy({ delegateId });
  }
}
