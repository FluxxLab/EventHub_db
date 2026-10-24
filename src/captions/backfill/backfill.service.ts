import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { RealtimeService, Rooms } from '../../common/realtime/realtime.service';
import { StorageService } from '../../common/storage/storage.service';
import { EditionsService } from '../../editions/editions.service';
import { Session, SessionStatus } from '../../sessions/entities/session.entity';
import { MAX_TERMS } from '../caption-terms';
import { CaptionsService, effectiveTimeSql, seqOf } from '../captions.service';
import type { CaptionPayload } from '../captions.service';
import {
  TranscriptSegment,
  TranscriptSource,
} from '../entities/transcript-segment.entity';
import { maskProfanity } from '../profanity';
import { TRANSCRIPTION_PROVIDER } from '../transcription/transcription.interface';
import type { TranscriptionProvider } from '../transcription/transcription.interface';
import {
  BACKFILL_FOLDER,
  COVER_AFTER_MS,
  COVER_BEFORE_MS,
  isCovered,
  placeLines,
  SESSION_LEAD_MS,
  SESSION_TAIL_MS,
} from './backfill-plan';
import type { BackfillSubmitDto, BackfillUploadDto } from './backfill.dto';
import { findPiecewiseOffset, offsetAt, plainText } from './align-recording';

/** What the caption-backfill queue carries. */
export interface BackfillJob {
  room: string;
  key: string;
  /** The desk's clock when the piece began (ISO). */
  startedAt: string;
  durationMs: number;
  /** Server clock minus desk clock at submit, ms. */
  skewMs: number;
  /** A stream's recording: its lines replace the live ones over its hours. */
  replace?: boolean;
}

export interface BackfillResult {
  inserted: number;
  skipped: number;
  sessions: { id: string; title: string; inserted: number }[];
  /** A re-caption: how far its given start time was corrected, ms (null when it could not be checked). */
  shiftedMs?: number | null;
  /** A re-caption: lines from an earlier run of the same recording removed from elsewhere in the day. */
  staleRemoved?: number;
}

/** A re-caption looks for its recording in the live captions this far either side of its given start. */
const SEARCH_MS = 12 * 60 * 60_000;
/** A line this long or longer is distinctive enough to recognise as a copy from an earlier run. */
const COPY_MIN_WORDS = 5;

export interface BackfillStatus extends Partial<BackfillResult> {
  state: 'waiting' | 'active' | 'completed' | 'failed';
  error?: string;
}

/** Finished jobs are kept this long, so a desk can still ask how one went. */
const KEEP_JOBS_SECONDS = 7 * 24 * 60 * 60;

/**
 * Captions a capture desk could not send live.
 *
 * A desk on a weak link keeps its own recording of what it could not stream
 * and uploads it later - minutes or hours afterwards - straight to storage.
 * The recording is transcribed off the request path, each line is placed on
 * the server's clock and in the session that was running in the room, and
 * only the lines the live captions do not already have are stored.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly transcription: TranscriptionProvider,
    @InjectQueue('caption-backfill')
    private readonly queue: Queue<BackfillJob>,
    private readonly storage: StorageService,
    private readonly editions: EditionsService,
    private readonly captions: CaptionsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** A presigned PUT bound to the recording's exact size and type. */
  async uploadUrl(
    dto: BackfillUploadDto,
  ): Promise<{ url: string; key: string }> {
    const { uploadUrl, key } = await this.storage.presignUpload({
      folder: BACKFILL_FOLDER,
      contentType: dto.contentType,
      contentLength: dto.bytes,
    });
    return { url: uploadUrl, key };
  }

  /**
   * Queues an uploaded recording. One job per key: a desk resubmitting after
   * a lost response gets the same job back rather than a second pass.
   */
  async submit(dto: BackfillSubmitDto): Promise<{ jobId: string }> {
    const jobId = BackfillService.jobIdOf(dto.key);
    if (await this.queue.getJob(jobId)) return { jobId };

    if (!(await this.storage.headObject(dto.key))) {
      throw new BadRequestException('That recording has not been uploaded');
    }
    const skewMs = Date.now() - Date.parse(dto.deskNow);
    await this.queue.add(
      'backfill',
      {
        room: dto.room.trim(),
        key: dto.key,
        startedAt: dto.startedAt,
        durationMs: dto.durationMs,
        skewMs,
        ...(dto.replace ? { replace: true } : {}),
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: KEEP_JOBS_SECONDS },
        removeOnFail: { age: KEEP_JOBS_SECONDS },
      },
    );
    return { jobId };
  }

  /** How a queued recording is getting on. */
  async status(jobId: string): Promise<BackfillStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) throw new NotFoundException('No such back-fill job');
    const state = await job.getState();
    if (state === 'completed') {
      return { state, ...(job.returnvalue as BackfillResult) };
    }
    if (state === 'failed') return { state, error: job.failedReason };
    // delayed is a retry waiting out its backoff
    return { state: state === 'active' ? 'active' : 'waiting' };
  }

  /** The job for a key (`caption-backfill/<uuid>` -> `backfill-<uuid>`). */
  static jobIdOf(key: string): string {
    return `backfill-${key.slice(BACKFILL_FOLDER.length + 1)}`;
  }

  /** The job itself: transcribe, place, store what is new. */
  async run(job: BackfillJob): Promise<BackfillResult> {
    const recordingStart = Date.parse(job.startedAt) + job.skewMs;
    if (job.replace) return this.recaption(job, recordingStart);
    const sessions = await this.candidateSessions(
      job.room,
      recordingStart,
      recordingStart + job.durationMs,
    );
    // Nothing ran in the room then: no line could be placed, so Deepgram is
    // not paid to transcribe it.
    if (sessions.length === 0) {
      this.logger.warn(
        `back-fill ${job.key}: no session in ${job.room} at ${new Date(recordingStart).toISOString()}`,
      );
      return { inserted: 0, skipped: 0, sessions: [] };
    }

    if (!this.transcription.transcribeUrl) {
      throw new UnrecoverableError('Transcription is not configured');
    }
    if (!(await this.storage.headObject(job.key))) {
      throw new UnrecoverableError('The recording is no longer in storage');
    }

    const keywords = await this.keywordsFor(sessions.map((s) => s.id));
    const url = await this.storage.presignRead(job.key, 60 * 60);
    const utterances = await this.transcription.transcribeUrl(url, {
      keywords,
    });

    const { placed, skipped: unplaced } = placeLines(
      utterances,
      sessions,
      recordingStart,
    );
    let skipped = unplaced;

    const bySession = new Map<string, typeof placed>();
    for (const line of placed) {
      const lines = bySession.get(line.sessionId) ?? [];
      lines.push(line);
      bySession.set(line.sessionId, lines);
    }

    const rows: TranscriptSegment[] = [];
    const counts: BackfillResult['sessions'] = [];
    for (const [sessionId, lines] of bySession) {
      const session = sessions.find((s) => s.id === sessionId)!;
      const said = await this.saidTimes(
        sessionId,
        Math.min(...lines.map((l) => l.start)),
        Math.max(...lines.map((l) => l.end)),
      );
      let inserted = 0;
      for (const line of lines) {
        if (isCovered(said, line.start, line.end)) {
          skipped += 1;
          continue;
        }
        inserted += 1;
        rows.push(
          this.segments.create({
            sessionId,
            room: session.room,
            text: line.text,
            speaker: line.speaker ?? null,
            language: 'en',
            source: TranscriptSource.AI,
            backfill: true,
            offsetMs: null,
            createdAt: new Date(line.start),
          }),
        );
      }
      counts.push({ id: sessionId, title: session.title, inserted });
    }

    if (rows.length > 0) {
      await this.segments.manager.transaction((manager) =>
        manager.save(TranscriptSegment, rows),
      );
      this.announce(rows);
    }

    this.logger.log(
      `back-fill ${job.key} (${job.room}): ${rows.length} line(s) added, ${skipped} skipped`,
    );
    return { inserted: rows.length, skipped, sessions: counts };
  }

  /**
   * A stream's recording put in place of the live captions. Its start time
   * is checked against the live captions first (see align-recording): a
   * stream's "started" time can be hours off, and trusting it files the
   * whole recording under the wrong sessions. Then, over the stretch it
   * covers, every machine line in the room gives way to the recording's,
   * whichever session it was filed under, and copies of these same lines
   * left elsewhere in the day by an earlier, misplaced run are removed.
   * Lines a person typed stay. Stored as ordinary lines, so speaker names
   * apply to them.
   */
  private async recaption(
    job: BackfillJob,
    givenStart: number,
  ): Promise<BackfillResult> {
    if (!this.transcription.transcribeUrl) {
      throw new UnrecoverableError('Transcription is not configured');
    }
    if (!(await this.storage.headObject(job.key))) {
      throw new UnrecoverableError('The recording is no longer in storage');
    }
    const roomSessions = await this.roomSessions(job.room);
    if (roomSessions.length === 0) {
      this.logger.warn(`re-caption ${job.key}: no session in ${job.room}`);
      return { inserted: 0, skipped: 0, sessions: [], shiftedMs: null };
    }
    const nearby = roomSessions.filter(
      (s) =>
        s.endsAt.getTime() >= givenStart - SEARCH_MS &&
        s.startsAt.getTime() <= givenStart + job.durationMs + SEARCH_MS,
    );
    const keywords = await this.keywordsFor(nearby.map((s) => s.id));
    const url = await this.storage.presignRead(job.key, 60 * 60);
    const utterances = await this.transcription.transcribeUrl(url, {
      keywords,
    });

    // the recording's own distinctive lines: copies of them elsewhere come from an earlier run
    // the recording's own lines, by text, with where an earlier run given
    // this same start would have stored them
    const said = new Map<string, number[]>();
    for (const u of utterances) {
      const t = plainText(u.text);
      said.set(t, [...(said.get(t) ?? []), givenStart + u.startMs]);
    }
    /** A stored line that is this recording's own, left by an earlier run. */
    const isCopy = (l: { text: string; at: number }) => {
      const t = plainText(l.text);
      const at = said.get(t);
      if (!at) return false;
      return (
        t.split(' ').length >= COPY_MIN_WORDS ||
        at.some((x) => Math.abs(x - l.at) <= 3_000)
      );
    };
    const ids = roomSessions.map((s) => s.id);
    const heard = await this.roomLines(
      ids,
      givenStart - SEARCH_MS,
      givenStart + job.durationMs + SEARCH_MS,
    );
    // matched only against what was heard live: anything worded exactly
    // like the recording is likely an earlier run's copy, and would pull the
    // answer towards wherever that run put it
    const live = heard.filter(
      (l) => l.source === 'ai' && !said.has(plainText(l.text)),
    );
    // matched piece by piece: a stream that dropped and resumed skips the
    // time it was down, so one start cannot fit a whole day
    const found = findPiecewiseOffset(utterances, live, givenStart);
    // Unchecked, a wrong start replaces live captions with the wrong ones.
    // Go ahead only when there are none to lose where it would land.
    if (!found) {
      const atRisk = live.filter(
        (l) => l.at >= givenStart && l.at <= givenStart + job.durationMs,
      ).length;
      if (atRisk > 0) {
        throw new UnrecoverableError(
          `The recording could not be matched to the live captions, so its start time could not be checked, and ${atRisk} live lines would be replaced. Nothing was changed. Check the start time and the room.`,
        );
      }
    }
    const shiftOf = (ms: number) => (found ? offsetAt(found, ms) : 0);
    const shiftedMs = found ? found.offsets[0] : null;
    const firstShift = found ? Math.min(...found.offsets) : 0;
    const lastShift = found ? Math.max(...found.offsets) : 0;
    const start = givenStart + firstShift;
    const end = givenStart + job.durationMs + lastShift;
    if (found) {
      this.logger.log(
        `re-caption ${job.key} (${job.room}): ${found.matched}/${found.pieces} piece(s) matched, shifts by piece ${found.offsets.map((o) => Math.round(o / 60_000)).join(', ')} min`,
      );
    }
    // each line moved by its own piece's shift
    const shifted = utterances.map((u) => {
      const d = shiftOf(u.startMs);
      return { ...u, startMs: u.startMs + d, endMs: u.endMs + d };
    });

    const sessions = roomSessions.filter(
      (s) =>
        (s.status === SessionStatus.LIVE ||
          s.status === SessionStatus.COMPLETED) &&
        s.startsAt.getTime() - SESSION_LEAD_MS <= end &&
        s.endsAt.getTime() + SESSION_TAIL_MS >= start,
    );
    const { placed, skipped } = placeLines(shifted, sessions, givenStart);
    if (placed.length === 0) {
      return {
        inserted: 0,
        skipped,
        sessions: [],
        shiftedMs,
      };
    }
    const from = new Date(
      Math.min(...placed.map((l) => l.start)) - COVER_BEFORE_MS,
    );
    const to = new Date(Math.max(...placed.map((l) => l.end)) + COVER_AFTER_MS);

    const rows: TranscriptSegment[] = [];
    const counts = new Map<
      string,
      { id: string; title: string; inserted: number }
    >();
    let staleRemoved = 0;
    await this.segments.manager.transaction(async (manager) => {
      // the room's machine lines over the stretch, in any session
      await manager.query(
        `DELETE FROM transcript_segments seg
          WHERE seg."sessionId" = ANY($1::varchar[]) AND seg.source = 'ai'
            AND ${effectiveTimeSql('seg')} BETWEEN $2 AND $3`,
        [ids, from.toISOString(), to.toISOString()],
      );
      // copies of these lines elsewhere in the day, left by an earlier run
      const stale = (
        await this.roomLines(
          ids,
          Math.min(givenStart, start) - SEARCH_MS,
          Math.max(givenStart + job.durationMs, end) + SEARCH_MS,
          manager,
        )
      )
        .filter((l) => l.source === 'ai' && isCopy(l))
        .map((l) => l.id);
      for (let i = 0; i < stale.length; i += 500) {
        await manager.query(
          `DELETE FROM transcript_segments WHERE id = ANY($1::uuid[])`,
          [stale.slice(i, i + 500)],
        );
      }
      staleRemoved = stale.length;
      for (const line of placed) {
        const session = sessions.find((s) => s.id === line.sessionId)!;
        rows.push(
          this.segments.create({
            sessionId: line.sessionId,
            room: session.room,
            text: line.text,
            speaker: line.speaker ?? null,
            language: 'en',
            source: TranscriptSource.AI,
            backfill: false,
            offsetMs: null,
            createdAt: new Date(line.start),
          }),
        );
        const c = counts.get(session.id) ?? {
          id: session.id,
          title: session.title,
          inserted: 0,
        };
        c.inserted += 1;
        counts.set(session.id, c);
      }
      if (rows.length > 0) await manager.save(TranscriptSegment, rows);
    });
    this.logger.log(
      `re-caption ${job.key} (${job.room}): ${rows.length} line(s) in ${counts.size} session(s), ${skipped} outside any session, ${staleRemoved} stale copies removed`,
    );
    return {
      inserted: rows.length,
      skipped,
      sessions: [...counts.values()],
      shiftedMs,
      staleRemoved,
    };
  }

  /** The room's sessions in the current event (any event when none is current). */
  private async roomSessions(room: string): Promise<Session[]> {
    const edition = await this.editions.current(true);
    const qb = this.segments.manager
      .createQueryBuilder(Session, 's')
      .where('LOWER(TRIM(s.room)) = LOWER(TRIM(:room))', { room });
    if (edition)
      qb.andWhere('s.editionId = :editionId', { editionId: edition.id });
    return qb.getMany();
  }

  /** The English lines stored in these sessions between two times, with when they were heard. */
  private async roomLines(
    sessionIds: string[],
    from: number,
    to: number,
    manager = this.segments.manager,
  ): Promise<{ id: string; text: string; source: string; at: number }[]> {
    const rows = await manager.query<
      { id: string; text: string; source: string; at: Date | string }[]
    >(
      `SELECT seg.id, seg.text, seg.source, ${effectiveTimeSql('seg')} AS at
         FROM transcript_segments seg
        WHERE seg."sessionId" = ANY($1::varchar[]) AND seg.language = 'en'
          AND ${effectiveTimeSql('seg')} BETWEEN $2 AND $3`,
      [sessionIds, new Date(from).toISOString(), new Date(to).toISOString()],
    );
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      at: new Date(r.at).getTime(),
    }));
  }

  /** Deletes the uploaded recording; it is only ever read once. */
  async discard(key: string): Promise<void> {
    await this.storage
      .deleteObject(key)
      .catch((error: Error) =>
        this.logger.warn(`could not delete ${key}: ${error.message}`),
      );
  }

  /**
   * Sessions in the room, live or finished, whose window overlaps the piece:
   * the current event's when one is current (room names repeat between
   * events), any event's otherwise.
   */
  private async candidateSessions(
    room: string,
    from: number,
    to: number,
  ): Promise<Session[]> {
    const edition = await this.editions.current(true);
    const qb = this.segments.manager
      .createQueryBuilder(Session, 's')
      .where('LOWER(TRIM(s.room)) = LOWER(TRIM(:room))', { room })
      .andWhere('s.status IN (:...statuses)', {
        statuses: [SessionStatus.LIVE, SessionStatus.COMPLETED],
      })
      .andWhere('s.startsAt <= :latest', {
        latest: new Date(to + SESSION_LEAD_MS),
      })
      .andWhere('s.endsAt >= :earliest', {
        earliest: new Date(from - SESSION_TAIL_MS),
      });
    if (edition)
      qb.andWhere('s.editionId = :editionId', { editionId: edition.id });
    return qb.getMany();
  }

  /** The candidate sessions' terms together, as many as Deepgram takes. */
  private async keywordsFor(sessionIds: string[]): Promise<string[]> {
    const seen = new Map<string, string>();
    for (const id of sessionIds) {
      for (const term of await this.captions.termsFor(id)) {
        if (!seen.has(term.toLowerCase())) seen.set(term.toLowerCase(), term);
      }
    }
    return [...seen.values()].slice(0, MAX_TERMS);
  }

  /** When the session's stored English lines were said, ascending, near a span. */
  private async saidTimes(
    sessionId: string,
    from: number,
    to: number,
  ): Promise<number[]> {
    const at = effectiveTimeSql('seg');
    const rows = await this.segments
      .createQueryBuilder('seg')
      .select(`EXTRACT(EPOCH FROM ${at}) * 1000`, 'at')
      .where('seg.sessionId = :sessionId', { sessionId })
      .andWhere("seg.language = 'en'")
      .andWhere(`${at} BETWEEN :from AND :to`, {
        from: new Date(from - 60_000),
        to: new Date(to + 60_000),
      })
      .orderBy('at', 'ASC')
      .getRawMany<{ at: string | number }>();
    return rows.map((r) => Number(r.at));
  }

  /** Back-filled lines go out to open caption screens, as history. */
  private announce(rows: TranscriptSegment[]): void {
    for (const row of [...rows].sort((a, b) => seqOf(a) - seqOf(b))) {
      this.realtime.emitToRoom(Rooms.caption(row.sessionId), 'caption', {
        sessionId: row.sessionId,
        text: maskProfanity(row.text),
        isFinal: true,
        backfill: true,
        aiGenerated: true,
        language: 'en',
        speaker: row.speaker,
        at: row.createdAt.toISOString(),
        seq: seqOf(row),
      } satisfies CaptionPayload);
    }
  }
}
