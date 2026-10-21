import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { In, Not, Repository } from 'typeorm';
import { RealtimeService, Rooms } from '../../common/realtime/realtime.service';
import { EditionsService } from '../../editions/editions.service';
import type { SpeakerNaming } from '../../editions/entities/edition.entity';
import {
  SessionStatus,
  type Session,
} from '../../sessions/entities/session.entity';
import { SessionsService } from '../../sessions/sessions.service';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import { effectiveTimeSql, seqOf } from '../segment-time';
import { ClaudeSpeakerNamer, type NamerLine } from './speaker-namer';
import {
  SpeakerName,
  speakerNameJson,
  type SpeakerNameJson,
  type SpeakerNameKind,
} from './speaker-name.entity';
import {
  appliedBindingFor,
  attribute,
  bindingsClosedBy,
  bindingsEndedByReopen,
  claimsIntroduction,
  CONTEXT_LINES,
  INTRO_DELAY_MS,
  INTRO_WINDOW_MS,
  introductionCandidate,
  isApplied,
  lineKey,
  matchProgramme,
  micGapExpired,
  MIN_CONFIDENCE,
  planReview,
  REVIEW_CHUNK_LINES,
  selfBindingStart,
  SESSION_LEAD_MS,
  statusFor,
  type Attribution,
  type LineRef,
  type NewBinding,
  type PendingIntro,
  type ProgrammeSpeaker,
  type ReviewFinding,
  type ReviewNaming,
} from './speaker-naming-plan';
import type {
  CreateSpeakerNameDto,
  UpdateSpeakerNameDto,
} from './speaker-names.dto';

/** What the speaker-intro queue carries: one caption line worth a look. */
export interface IntroJob {
  sessionId: string;
  room: string;
  segmentId: string;
  kind: SpeakerNameKind;
  key: number;
  /** When the line was said (ISO). */
  at: string;
  /** When the room's current stream run opened (ISO), or null if unknown. */
  runStartedAt: string | null;
}

/** What the speaker-review queue carries. */
export interface ReviewJob {
  sessionId: string;
}

export interface ReviewResult {
  added: number;
  changed: number;
}

export interface ReviewStatus extends Partial<ReviewResult> {
  state: 'waiting' | 'active' | 'completed' | 'failed';
  error?: string;
}

/** A final caption line as the live pipeline hands it over. */
export interface FinalLine {
  id: string;
  sessionId: string;
  room: string;
  text: string;
  speaker: number | null;
  mic: number | null;
  language: string;
  /** Epoch ms, when it was said. */
  at: number;
}

/** Finished review jobs are kept this long so the console can still ask. */
const KEEP_JOBS_SECONDS = 24 * 60 * 60;
/** How many lines after "please welcome X" are checked for X's first line. */
const CLAIM_SCAN_LINES = 60;

/** How long a session's names are trusted from memory before being read again. */
const APPLIED_TTL_MS = 30_000;

const roomKey = (room: string) => room.trim().toLowerCase();
const hms = (at: number) => new Date(at).toISOString().slice(11, 19);

/**
 * Names for the voices and mics in a session's captions.
 *
 * Live, each final line is checked for the shape of an introduction and, if
 * it has one, handed to a queued job that asks Claude who was introduced;
 * the answer becomes a binding (see SpeakerName) that names the voice or mic
 * from then on - applied at once when it is someone on the programme,
 * suggested to an operator otherwise. Operators can also name, confirm,
 * reject and delete bindings, and ask for a review of the whole session.
 *
 * Per-room state (when the stream's run opened, which voices it has heard,
 * when each mic last spoke, a pending "please welcome") lives in memory on
 * the instance captioning the room, like the stream itself.
 */
@Injectable()
export class SpeakerNamesService {
  private readonly logger = new Logger(SpeakerNamesService.name);

  /** Applied bindings per session, for naming lines without a query each. */
  private readonly applied = new Map<string, SpeakerName[]>();
  /** When each session's bindings were read: re-read after APPLIED_TTL_MS, as the other API instance may have changed them. */
  private readonly appliedAt = new Map<string, number>();
  private readonly loading = new Map<string, Promise<SpeakerName[]>>();

  /** The stream run each captioned room is in, by normalised room. */
  private readonly runs = new Map<
    string,
    { sessionId: string; startedAt: number }
  >();
  /** "Please welcome X", by session, until X speaks or it expires. */
  private readonly pending = new Map<string, PendingIntro>();
  /** When each mic last had a line, by `${sessionId}:${mic}`. */
  private readonly lastOnMic = new Map<string, number>();

  constructor(
    @InjectRepository(SpeakerName)
    private readonly names: Repository<SpeakerName>,
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    @InjectQueue('speaker-intro')
    private readonly introQueue: Queue<IntroJob>,
    @InjectQueue('speaker-review')
    private readonly reviewQueue: Queue<ReviewJob>,
    private readonly sessions: SessionsService,
    private readonly editions: EditionsService,
    private readonly realtime: RealtimeService,
    private readonly namer: ClaudeSpeakerNamer,
  ) {}

  /* ------------------------------------------------------------ naming */

  /** The session's applied bindings, from the cache or the database. */
  async appliedFor(sessionId: string): Promise<SpeakerName[]> {
    const hit = this.applied.get(sessionId);
    if (
      hit &&
      Date.now() - (this.appliedAt.get(sessionId) ?? 0) < APPLIED_TTL_MS
    )
      return hit;
    let load = this.loading.get(sessionId);
    if (!load) {
      load = this.names
        .find({
          where: { sessionId, status: In(['auto', 'confirmed']) },
          order: { fromAt: 'ASC' },
        })
        .then((rows) => {
          this.applied.set(sessionId, rows);
          this.appliedAt.set(sessionId, Date.now());
          return rows;
        })
        .finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, load);
    }
    return load;
  }

  /**
   * The applied bindings as this instance knows them right now, for the live
   * path, which cannot wait on a query per line. Empty until loaded (the load
   * is started); runStarted loads them before the first line.
   */
  appliedNow(sessionId: string): SpeakerName[] {
    const hit = this.applied.get(sessionId);
    if (hit) return hit;
    void this.appliedFor(sessionId).catch((error: Error) =>
      this.logger.warn(
        `speaker names for ${sessionId} not loaded: ${error.message}`,
      ),
    );
    return [];
  }

  /** Who said a line, from the mic's label or the applied bindings (cached). */
  attributeNow(
    sessionId: string,
    line: LineRef,
    micLabel: Attribution | null | undefined,
  ): Attribution {
    return attribute(line, micLabel, this.appliedNow(sessionId));
  }

  /** Who said a line, loading the session's bindings if need be. */
  async attribute(
    sessionId: string,
    line: LineRef,
    micLabel: Attribution | null | undefined,
  ): Promise<Attribution> {
    return attribute(line, micLabel, await this.appliedFor(sessionId));
  }

  /* --------------------------------------------------------- live hooks */

  /**
   * The room's stream opened or reopened for a session: its voice indexes
   * start again, so every open voice binding ends now, and the run's clock
   * starts. Called by the captions pipeline.
   */
  async runStarted(room: string, sessionId: string): Promise<void> {
    const now = Date.now();
    this.runs.set(roomKey(room), { sessionId, startedAt: now });
    this.pending.delete(sessionId);
    try {
      const open = await this.names.find({
        where: { sessionId, kind: 'speaker', status: Not('rejected') },
      });
      const ended = bindingsEndedByReopen(open);
      for (const b of ended) {
        b.toAt = new Date(now);
        await this.names.save(b);
      }
      await this.refresh(sessionId);
      for (const b of ended) this.announce(b);
    } catch (error) {
      this.logger.warn(
        `could not reset speaker names for ${sessionId}: ${(error as Error).message}`,
      );
    }
  }

  /** The room stopped being captioned; its run state is dropped. */
  runEnded(room: string): void {
    const run = this.runs.get(roomKey(room));
    this.runs.delete(roomKey(room));
    if (run) this.pending.delete(run.sessionId);
  }

  /** When the room's current run opened, if this instance captions it. */
  runStartedAt(room: string): number | null {
    return this.runs.get(roomKey(room))?.startedAt ?? null;
  }

  /**
   * A final English line was stored. Three things may follow: a mic that was
   * silent for minutes drops its binding; a pending introduction is claimed
   * by the newcomer's first line; and a line shaped like an introduction is
   * queued for the model. Never throws: a name is never worth a caption.
   */
  async onFinal(line: FinalLine): Promise<void> {
    try {
      const key = lineKey(line);
      if (!key) return;

      if (key.kind === 'mic') await this.watchMicGap(line, key.key);

      const pending = this.pending.get(line.sessionId);
      if (pending) {
        if (line.at > pending.until) this.pending.delete(line.sessionId);
        else if (
          claimsIntroduction(
            pending,
            line,
            appliedBindingFor(this.appliedNow(line.sessionId), line) !== null,
          )
        ) {
          this.pending.delete(line.sessionId);
          await this.bind({
            sessionId: line.sessionId,
            kind: key.kind,
            key: key.key,
            name: pending.name,
            organisation: pending.organisation,
            speakerId: pending.speakerId,
            status: pending.status,
            source: 'introduction',
            evidence: pending.evidence,
            fromAt: new Date(line.at),
            toAt: null,
          });
        }
      }

      if (line.language === 'en' && introductionCandidate(line.text)) {
        const run = this.runs.get(roomKey(line.room));
        await this.introQueue.add(
          'introduction',
          {
            sessionId: line.sessionId,
            room: line.room,
            segmentId: line.id,
            kind: key.kind,
            key: key.key,
            at: new Date(line.at).toISOString(),
            runStartedAt: run ? new Date(run.startedAt).toISOString() : null,
          },
          {
            jobId: `intro-${line.id}`,
            delay: INTRO_DELAY_MS,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    } catch (error) {
      this.logger.warn(
        `speaker naming skipped a line in ${line.sessionId}: ${(error as Error).message}`,
      );
    }
  }

  /** A mic quiet for longer than MIC_GAP_MS ends whoever's binding it carried. */
  private async watchMicGap(line: FinalLine, mic: number): Promise<void> {
    const cacheKey = `${line.sessionId}:${mic}`;
    const last = this.lastOnMic.get(cacheKey);
    this.lastOnMic.set(cacheKey, line.at);
    if (!micGapExpired(last, line.at)) return;
    const open = await this.names.find({
      where: {
        sessionId: line.sessionId,
        kind: 'mic',
        key: mic,
        status: Not('rejected'),
      },
    });
    const ended = open.filter((b) => b.toAt === null);
    if (ended.length === 0) return;
    for (const b of ended) {
      b.toAt = new Date(last!);
      await this.names.save(b);
    }
    await this.refresh(line.sessionId);
    for (const b of ended) this.announce(b);
  }

  /* ------------------------------------------------------ introductions */

  /** The queued look at one line: is it an introduction, and of whom? */
  async runIntro(job: IntroJob): Promise<void> {
    if (!this.namer.configured) return;
    const segment = await this.segments.findOneBy({ id: job.segmentId });
    if (!segment) return;
    const session = await this.sessions.findById(job.sessionId);
    const setting = await this.settingFor(session);
    if (setting === 'off') return;

    const at = seqOf(segment);
    const speakers = programmeOf(session);
    const bindings = await this.names.find({
      where: { sessionId: job.sessionId, status: Not('rejected') },
    });
    const [before, after] = await Promise.all([
      this.neighbours(job.sessionId, at, 'before', segment.id),
      this.neighbours(job.sessionId, at, 'after', segment.id),
    ]);
    const label = (row: TranscriptSegment) => this.labelOf(row, bindings, true);
    const answer = await this.namer.identify({
      session: session.title,
      speakers,
      before: before.map((r) => ({
        who: label(r),
        text: r.text,
        at: hms(seqOf(r)),
      })),
      line: { who: label(segment), text: segment.text, at: hms(at) },
      after: after.map((r) => ({
        who: label(r),
        text: r.text,
        at: hms(seqOf(r)),
      })),
    });
    if (!answer || answer.kind === 'none') return;
    if (answer.confidence < MIN_CONFIDENCE) {
      this.logger.debug(
        `introduction in ${job.sessionId} not sure enough (${answer.confidence}): ${answer.reason}`,
      );
      return;
    }
    const speaker = matchProgramme(
      speakers,
      answer.programmeSpeakerId,
      answer.name,
    );
    const name = (speaker?.name ?? answer.name ?? '').trim().slice(0, 255);
    const status = statusFor(setting, !!speaker);
    if (!name || !status) return;
    const organisation =
      (speaker?.organisation ?? answer.organisation)?.trim().slice(0, 255) ||
      null;

    if (answer.kind === 'self') {
      // Said twice, or found again by a reopen: the same name already on the
      // key at that moment is nothing new.
      const already = bindings.some(
        (b) =>
          b.kind === job.kind &&
          b.key === job.key &&
          b.name.toLowerCase() === name.toLowerCase() &&
          b.fromAt.getTime() <= at &&
          (b.toAt === null || b.toAt.getTime() > at),
      );
      if (already) return;
      const fromAt = selfBindingStart(job.kind, {
        at,
        runStartedAt: job.runStartedAt ? Date.parse(job.runStartedAt) : null,
        sessionStartsAt: session.startsAt.getTime(),
        firstLineOnMicAt:
          job.kind === 'mic'
            ? await this.firstLineOnMicSince(
                job.sessionId,
                job.key,
                bindings,
                at,
                session.startsAt.getTime() - SESSION_LEAD_MS,
              )
            : null,
      });
      await this.bind({
        sessionId: job.sessionId,
        kind: job.kind,
        key: job.key,
        name,
        organisation,
        speakerId: speaker?.id ?? null,
        status,
        source: 'introduction',
        evidence: segment.text,
        fromAt: new Date(fromAt),
        toAt: null,
      });
      return;
    }

    // Third party: the next new voice (or another mic) within the window is
    // the person introduced. Lines said since the introduction are checked
    // now; if none claims it, the live path watches the lines to come.
    const seenBefore = await this.voicesHeardBefore(
      job.sessionId,
      job.runStartedAt ? Date.parse(job.runStartedAt) : null,
      at,
    );
    const pending: PendingIntro = {
      name,
      organisation,
      speakerId: speaker?.id ?? null,
      status,
      evidence: segment.text,
      introducerKind: job.kind,
      introducerKey: job.key,
      seenBefore,
      until: at + INTRO_WINDOW_MS,
    };
    const applied = bindings.filter(isApplied);
    // Everything said since, up to the window - more than the model saw.
    const since = await this.neighbours(
      job.sessionId,
      at,
      'after',
      segment.id,
      CLAIM_SCAN_LINES,
    );
    for (const row of since) {
      if (seqOf(row) > pending.until) break;
      const line: LineRef = {
        speaker: row.speaker,
        mic: row.mic,
        at: seqOf(row),
        backfill: row.backfill,
      };
      if (
        !claimsIntroduction(pending, line, !!appliedBindingFor(applied, line))
      )
        continue;
      const k = lineKey(line)!;
      await this.bind({
        sessionId: job.sessionId,
        kind: k.kind,
        key: k.key,
        name,
        organisation,
        speakerId: speaker?.id ?? null,
        status,
        source: 'introduction',
        evidence: segment.text,
        fromAt: new Date(line.at),
        toAt: null,
      });
      return;
    }
    if (Date.now() <= pending.until) this.pending.set(job.sessionId, pending);
  }

  /** The lines just before or after a moment, nearest first for 'before'. */
  private async neighbours(
    sessionId: string,
    at: number,
    side: 'before' | 'after',
    excludeId: string,
    count = CONTEXT_LINES,
  ): Promise<TranscriptSegment[]> {
    const time = effectiveTimeSql('seg');
    const qb = this.segments
      .createQueryBuilder('seg')
      .addSelect(time, 'effective_at')
      .where('seg.sessionId = :sessionId', { sessionId })
      .andWhere("seg.language = 'en'")
      .andWhere('seg.id != :excludeId', { excludeId })
      .limit(count);
    if (side === 'before') {
      qb.andWhere(`${time} <= :at`, { at: new Date(at) })
        .orderBy('effective_at', 'DESC')
        .addOrderBy('seg.createdAt', 'DESC');
    } else {
      qb.andWhere(`${time} >= :at`, { at: new Date(at) })
        .orderBy('effective_at', 'ASC')
        .addOrderBy('seg.createdAt', 'ASC');
    }
    const rows = await qb.getMany();
    return side === 'before' ? rows.reverse() : rows;
  }

  /** Voice indexes heard in the run (non-backfill lines) before a moment. */
  private async voicesHeardBefore(
    sessionId: string,
    runStartedAt: number | null,
    at: number,
  ): Promise<number[]> {
    const time = effectiveTimeSql('seg');
    const qb = this.segments
      .createQueryBuilder('seg')
      .select('DISTINCT seg.speaker', 'speaker')
      .where('seg.sessionId = :sessionId', { sessionId })
      .andWhere("seg.language = 'en'")
      .andWhere('seg.backfill = false')
      .andWhere('seg.speaker IS NOT NULL')
      .andWhere(`${time} < :at`, { at: new Date(at) });
    if (runStartedAt !== null)
      qb.andWhere(`${time} >= :from`, { from: new Date(runStartedAt) });
    const rows = await qb.getRawMany<{ speaker: number | string }>();
    return rows.map((r) => Number(r.speaker));
  }

  /**
   * When the mic's current holder first spoke: the first line on the mic
   * after its previous binding ended, or since just before the session.
   */
  private async firstLineOnMicSince(
    sessionId: string,
    mic: number,
    bindings: SpeakerName[],
    at: number,
    lead: number,
  ): Promise<number | null> {
    const endedBefore = bindings
      .filter(
        (b) =>
          b.kind === 'mic' &&
          b.key === mic &&
          b.toAt !== null &&
          b.toAt.getTime() <= at,
      )
      .map((b) => b.toAt!.getTime());
    const since = Math.max(lead, ...endedBefore);
    const time = effectiveTimeSql('seg');
    const row = await this.segments
      .createQueryBuilder('seg')
      .addSelect(time, 'effective_at')
      .where('seg.sessionId = :sessionId', { sessionId })
      .andWhere("seg.language = 'en'")
      .andWhere('seg.mic = :mic', { mic })
      .andWhere(`${time} >= :since`, { since: new Date(since) })
      .orderBy('effective_at', 'ASC')
      .addOrderBy('seg.createdAt', 'ASC')
      .limit(1)
      .getOne();
    return row ? seqOf(row) : null;
  }

  /* ------------------------------------------------------------ operator */

  /** The session's bindings an operator can see: everything not rejected, by start. */
  async list(sessionId: string): Promise<SpeakerNameJson[]> {
    const rows = await this.names.find({
      where: { sessionId, status: Not('rejected') },
      order: { fromAt: 'ASC', createdAt: 'ASC' },
    });
    return rows.map(speakerNameJson);
  }

  /** An operator names a voice or a mic: applied at once. */
  async create(
    sessionId: string,
    dto: CreateSpeakerNameDto,
  ): Promise<SpeakerNameJson> {
    const session = await this.sessions.findById(sessionId);
    const speaker = dto.speakerId
      ? (session.speakers ?? []).find((s) => s.id === dto.speakerId)
      : undefined;
    if (dto.speakerId && !speaker) {
      throw new BadRequestException('That speaker is not on this session.');
    }
    const lead = session.startsAt.getTime() - SESSION_LEAD_MS;
    const fromAt = dto.fromAt
      ? Date.parse(dto.fromAt)
      : dto.kind === 'speaker'
        ? (this.runStartedAt(session.room) ?? lead)
        : lead;
    const row = await this.bind({
      sessionId,
      kind: dto.kind,
      key: dto.key,
      name: dto.name.trim(),
      organisation: dto.organisation?.trim() || speaker?.organisation || null,
      speakerId: speaker?.id ?? null,
      status: 'confirmed',
      source: 'operator',
      evidence: null,
      fromAt: new Date(fromAt),
      toAt: null,
    });
    return speakerNameJson(row);
  }

  /** An operator confirms, rejects or corrects a binding. */
  async update(
    id: string,
    dto: UpdateSpeakerNameDto,
  ): Promise<SpeakerNameJson> {
    const row = await this.names.findOneBy({ id });
    if (!row) throw new NotFoundException('No such speaker name');
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.organisation !== undefined)
      row.organisation = dto.organisation?.trim() || null;
    if (dto.speakerId !== undefined) {
      if (dto.speakerId) {
        const session = await this.sessions.findById(row.sessionId);
        const speaker = (session.speakers ?? []).find(
          (s) => s.id === dto.speakerId,
        );
        if (!speaker)
          throw new BadRequestException('That speaker is not on this session.');
        row.speakerId = speaker.id;
        if (dto.name === undefined) row.name = speaker.name;
        if (dto.organisation === undefined && speaker.organisation)
          row.organisation = speaker.organisation;
      } else row.speakerId = null;
    }
    const wasApplied = isApplied(row);
    if (dto.status) row.status = dto.status;
    const saved = await this.names.save(row);
    // Confirming applies it, so whatever it overlaps on the key gives way.
    if (!wasApplied && isApplied(saved)) await this.closeOverlapping(saved);
    await this.refresh(saved.sessionId);
    this.announce(saved);
    return speakerNameJson(saved);
  }

  /** Gone for good; the console hears it as rejected. */
  async remove(id: string): Promise<void> {
    const row = await this.names.findOneBy({ id });
    if (!row) throw new NotFoundException('No such speaker name');
    await this.names.delete({ id });
    await this.refresh(row.sessionId);
    row.status = 'rejected';
    this.announce(row);
  }

  /* -------------------------------------------------------------- review */

  /** Queue a whole-session review; one job per request. */
  async queueReview(sessionId: string): Promise<{ jobId: string }> {
    if (!this.namer.configured) {
      throw new ServiceUnavailableException(
        'Speaker naming is not set up yet: add ANTHROPIC_API_KEY on the server.',
      );
    }
    const session = await this.sessions.findById(sessionId);
    if ((await this.settingFor(session)) === 'off') {
      throw new BadRequestException(
        'Speaker naming is switched off for this event.',
      );
    }
    const jobId = `review-${randomUUID()}`;
    await this.reviewQueue.add(
      'review',
      { sessionId },
      {
        jobId,
        removeOnComplete: { age: KEEP_JOBS_SECONDS },
        removeOnFail: { age: KEEP_JOBS_SECONDS },
      },
    );
    return { jobId };
  }

  /** How a queued review is getting on. */
  async reviewStatus(jobId: string): Promise<ReviewStatus> {
    const job = await this.reviewQueue.getJob(jobId);
    if (!job) throw new NotFoundException('No such review job');
    const state = await job.getState();
    if (state === 'completed')
      return { state, ...(job.returnvalue as ReviewResult) };
    if (state === 'failed') return { state, error: job.failedReason };
    return { state: state === 'active' ? 'active' : 'waiting' };
  }

  /**
   * The review itself: Claude reads the whole transcript with what is known
   * and says who spoke when; its findings replace the automatic bindings
   * they overlap, never an operator's.
   */
  async runReview(job: ReviewJob): Promise<ReviewResult> {
    const session = await this.sessions.findById(job.sessionId);
    // Live naming follows the event's switch. Reviewing a finished session is
    // an organiser's own request, after the room has moved on, so it names
    // everyone it hears introduced whatever the switch says.
    const setting: ReviewNaming =
      session.status === SessionStatus.COMPLETED
        ? 'finished'
        : await this.settingFor(session);
    if (setting === 'off') return { added: 0, changed: 0 };
    const rows = await this.segments
      .createQueryBuilder('seg')
      .addSelect(effectiveTimeSql('seg'), 'effective_at')
      .where('seg.sessionId = :sessionId', { sessionId: job.sessionId })
      .andWhere("seg.language = 'en'")
      .orderBy('effective_at', 'ASC')
      .addOrderBy('seg.createdAt', 'ASC')
      .getMany();
    if (rows.length === 0) return { added: 0, changed: 0 };

    const existing = await this.names.find({
      where: { sessionId: job.sessionId, status: Not('rejected') },
      order: { fromAt: 'ASC' },
    });
    const speakers = programmeOf(session);
    const lines: NamerLine[] = rows.map((r) => ({
      who: this.labelOf(r, existing, true),
      text: r.text,
      at: hms(seqOf(r)),
    }));
    const times = rows.map((r) => ({ at: seqOf(r) }));
    const lineOf = (at: number) => {
      let i = times.findIndex((t) => t.at >= at);
      if (i === -1) i = times.length;
      return i + 1;
    };
    const described = existing.map(
      (b) =>
        `${b.kind === 'mic' ? 'Mic' : 'Speaker'} ${b.kind === 'mic' ? b.key : b.key + 1}, lines ${lineOf(b.fromAt.getTime())}-${b.toAt ? Math.max(lineOf(b.toAt.getTime()) - 1, lineOf(b.fromAt.getTime())) : rows.length}: ${b.name}${b.organisation ? ` (${b.organisation})` : ''} [${b.status}${b.source === 'operator' ? ', operator' : ''}]`,
    );

    const findings: ReviewFinding[] = [];
    for (let start = 0; start < lines.length; start += REVIEW_CHUNK_LINES) {
      const chunk = await this.namer.review({
        session: session.title,
        speakers,
        bindings: described,
        firstLine: start + 1,
        totalLines: lines.length,
        lines: lines.slice(start, start + REVIEW_CHUNK_LINES),
      });
      if (chunk === null)
        throw new Error('The AI could not review the session');
      findings.push(...chunk);
    }

    const plan = planReview(findings, times, existing, setting, speakers);
    if (plan.remove.length > 0) {
      const removed = existing.filter((b) => plan.remove.includes(b.id));
      await this.names.delete({ id: In(plan.remove) });
      await this.refresh(job.sessionId);
      for (const b of removed) {
        b.status = 'rejected';
        this.announce(b);
      }
    }
    for (const b of plan.add) {
      await this.bind({
        ...b,
        sessionId: job.sessionId,
        source: 'review',
        evidence: null,
      });
    }
    this.logger.log(
      `speaker review of ${job.sessionId}: ${plan.add.length} added, ${plan.remove.length} replaced, ${plan.skipped} skipped`,
    );
    return { added: plan.add.length, changed: plan.remove.length };
  }

  /**
   * Lines moved to another session take their names with them: the applied
   * bindings covering the moved stretch are copied to the target, cut to it.
   * Returns how many were copied.
   */
  async copyForMove(
    fromId: string,
    toId: string,
    since?: Date,
    until?: Date,
  ): Promise<number> {
    const start = since?.getTime() ?? -Infinity;
    const end = until ? until.getTime() + 1 : Infinity;
    const source = await this.names.find({
      where: { sessionId: fromId, status: In(['auto', 'confirmed']) },
    });
    const copies = source
      .filter(
        (b) =>
          b.fromAt.getTime() < end &&
          (b.toAt === null || b.toAt.getTime() > start),
      )
      .map((b) =>
        this.names.create({
          sessionId: toId,
          kind: b.kind,
          key: b.key,
          name: b.name,
          organisation: b.organisation,
          speakerId: b.speakerId,
          status: b.status,
          source: b.source,
          evidence: b.evidence,
          fromAt: new Date(Math.max(b.fromAt.getTime(), start)),
          toAt:
            end === Infinity
              ? b.toAt
              : new Date(Math.min(b.toAt?.getTime() ?? end, end)),
        }),
      );
    if (copies.length) await this.names.save(copies);
    await this.refresh(toId);
    return copies.length;
  }

  /* ------------------------------------------------------------- shared */

  /**
   * Store a binding and tell the room. An applied one cuts short whatever it
   * overlaps on its kind/key; a suggestion sits alongside until confirmed.
   */
  private async bind(
    binding: Omit<NewBinding, 'status'> & {
      sessionId: string;
      status: SpeakerName['status'];
      source: SpeakerName['source'];
      evidence: string | null;
    },
  ): Promise<SpeakerName> {
    const row = await this.names.save(this.names.create(binding));
    if (isApplied(row)) await this.closeOverlapping(row);
    await this.refresh(row.sessionId);
    this.announce(row);
    return row;
  }

  /**
   * The cache reloaded after a change, before the room hears of it, so the
   * next live line is named by what the console is about to show. A failed
   * reload leaves the cache empty; the next read fills it.
   */
  private async refresh(sessionId: string): Promise<void> {
    this.applied.delete(sessionId);
    await this.appliedFor(sessionId).catch((error: Error) =>
      this.logger.warn(
        `speaker names for ${sessionId} not reloaded: ${error.message}`,
      ),
    );
  }

  private async closeOverlapping(row: SpeakerName): Promise<void> {
    const others = await this.names.find({
      where: {
        sessionId: row.sessionId,
        kind: row.kind,
        key: row.key,
        status: In(['auto', 'confirmed']),
      },
    });
    for (const b of bindingsClosedBy(others, row, row.id)) {
      b.toAt = row.fromAt;
      await this.names.save(b);
      this.announce(b);
    }
  }

  /** The event's setting for the session; the default where there is no event. */
  private async settingFor(session: Session): Promise<SpeakerNaming> {
    if (!session.editionId) return 'programme';
    try {
      return (await this.editions.findById(session.editionId)).speakerNaming;
    } catch {
      return 'programme';
    }
  }

  /** "Speaker 3 (Dr Amina Bello)", "Mic 2 (Someone?)" or "Unknown", as the model reads a line. */
  private labelOf(
    row: TranscriptSegment,
    bindings: SpeakerName[],
    withSuggestions: boolean,
  ): string {
    const line: LineRef = {
      speaker: row.speaker,
      mic: row.mic,
      at: seqOf(row),
      backfill: row.backfill,
    };
    const k = lineKey(line);
    if (!k || (k.kind === 'speaker' && row.backfill)) return 'Unknown';
    const base = k.kind === 'mic' ? `Mic ${k.key}` : `Speaker ${k.key + 1}`;
    const applied = appliedBindingFor(bindings, line);
    if (applied) return `${base} (${applied.name})`;
    if (!withSuggestions) return base;
    const suggested = bindings.find(
      (b) =>
        b.status === 'suggested' &&
        b.kind === k.kind &&
        b.key === k.key &&
        b.fromAt.getTime() <= line.at &&
        (b.toAt === null || line.at < b.toAt.getTime()),
    );
    return suggested ? `${base} (${suggested.name}?)` : base;
  }

  /**
   * Every change goes to the session's English caption room: the console
   * relabels earlier lines from it. Suggestions go as their own event so an
   * operator's screen can offer them; a deleted binding is sent as rejected.
   */
  private announce(row: SpeakerName): void {
    this.realtime.emitToRoom(
      Rooms.caption(row.sessionId, 'en'),
      row.status === 'suggested' ? 'captions:suggested' : 'captions:named',
      speakerNameJson(row),
    );
  }
}

/** The session's programmed speakers as the model and the matcher see them. */
function programmeOf(session: Session): ProgrammeSpeaker[] {
  return (session.speakers ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    organisation: s.organisation ?? null,
  }));
}
