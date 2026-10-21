import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { TranscriptSegment } from '../../captions/entities/transcript-segment.entity';
import { RealtimeService } from '../../common/realtime/realtime.service';
import { REDIS } from '../../common/redis/redis.module';
import { SessionsService } from '../../sessions/sessions.service';
import {
  changeoverCues,
  cleanVerdict,
  listenFor,
  roomPlans,
  type CaptionLine,
  type PlannedSession,
  type RoomPlan,
} from './switch-detector';
import { ClaudeSwitchSuggester } from './switch-suggester';
import { SwitchSuggestion } from './switch-suggestion.entity';

const MIN = 60_000;
/** How often rooms are looked at. */
export const TICK_MS = 30_000;
/** Captions read for a check: the last few minutes. */
const WINDOW_MS = 4 * MIN;
/** At most one Claude call per room in this long. */
const ROOM_GAP_MS = 2 * MIN;
/** A suggestion nobody answers is put away after this long. */
const OPEN_FOR_MS = 20 * MIN;
/** The same suggestion is not made again this soon after "not yet". */
const DISMISSED_QUIET_MS = 10 * MIN;
/** How sure Claude must be for a suggestion to be shown. */
const MIN_CONFIDENCE = 0.8;

const roomKey = (r: string) => r.trim().toLowerCase();

/** Midnight in Lagos (WAT, UTC+1, no daylight saving), for "today's" tally. */
export function lagosMidnight(now: Date): Date {
  const lagos = new Date(now.getTime() + 60 * MIN);
  return new Date(
    Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) -
      60 * MIN,
  );
}

/**
 * Suggests, on Live ops, when a room's next session has started or its live
 * one has ended, from what its captions say (see switch-detector.ts).
 *
 * Off unless SESSION_SWITCH_SUGGESTIONS=on. It reads captions after they are
 * saved and never touches the caption path, and it never changes a session:
 * a person switches from the suggestion, or says not yet. How each one was
 * answered is kept, to count how often they are right.
 */
@Injectable()
export class SessionSwitchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionSwitchService.name);
  private timer?: NodeJS.Timeout;
  readonly enabled: boolean;
  private readonly dailyCap: number;
  private capWarned = '';

  constructor(
    config: ConfigService,
    @InjectRepository(SwitchSuggestion)
    private readonly suggestions: Repository<SwitchSuggestion>,
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeService,
    private readonly suggester: ClaudeSwitchSuggester,
  ) {
    this.enabled =
      config.get<string>('SESSION_SWITCH_SUGGESTIONS')?.trim().toLowerCase() ===
      'on';
    this.dailyCap =
      Number(config.get('SESSION_SWITCH_DAILY_CAP') ?? 200) || 200;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    if (!this.suggester.configured) {
      this.logger.warn(
        'SESSION_SWITCH_SUGGESTIONS is on but ANTHROPIC_API_KEY is not set: no suggestions',
      );
      return;
    }
    this.logger.log(
      `switch suggestions on: rooms checked every ${TICK_MS / 1000}s, at most ${this.dailyCap} AI checks a day`,
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over the rooms, on one replica only. */
  async tick(now = new Date()): Promise<void> {
    try {
      const mine = await this.redis.set(
        'switch:tick',
        '1',
        'PX',
        TICK_MS - 2_000,
        'NX',
      );
      if (mine !== 'OK') return;
      const board = (await this.sessions.board()) as PlannedSession[];
      await this.settle(board, now);
      for (const plan of roomPlans(board)) await this.checkRoom(plan, now);
    } catch (error) {
      this.logger.warn(`switch tick failed: ${(error as Error).message}`);
    }
  }

  /**
   * Open suggestions the room has moved past: switched the way suggested
   * (right, even if nobody tapped it), moved on some other way, or left
   * unanswered too long.
   */
  private async settle(board: PlannedSession[], now: Date): Promise<void> {
    const open = await this.suggestions.find({ where: { status: 'open' } });
    for (const s of open) {
      const from = board.find((b) => b.id === s.fromSessionId);
      const to = s.toSessionId
        ? board.find((b) => b.id === s.toSessionId)
        : undefined;
      let status: SwitchSuggestion['status'] | null = null;
      if (s.kind === 'start_next' && to?.status === 'live') status = 'matched';
      else if (s.kind === 'end_current' && from?.status === 'completed')
        status = 'matched';
      else if (from?.status !== 'live') status = 'expired';
      else if (now.getTime() - s.createdAt.getTime() > OPEN_FOR_MS)
        status = 'expired';
      if (!status) continue;
      await this.suggestions.update(s.id, { status, decidedAt: now });
      this.realtime.emitGlobal('switch:suggestions', { room: s.room });
    }
  }

  private async checkRoom(plan: RoomPlan, now: Date): Promise<void> {
    const listening = listenFor(plan, now);
    if (!listening) return;
    const waiting = await this.suggestions.count({
      where: { room: plan.room, status: 'open' },
    });
    if (waiting) return;

    const rows = await this.segments.find({
      where: {
        sessionId: plan.live.id,
        language: 'en',
        createdAt: MoreThanOrEqual(new Date(now.getTime() - WINDOW_MS)),
      },
      order: { createdAt: 'ASC' },
      take: 150,
      select: { text: true, createdAt: true },
    });
    const lines: CaptionLine[] = rows
      .filter((r) => r.text?.trim())
      .map((r) => ({ at: r.createdAt, text: r.text.trim() }));
    if (lines.length < 3) return;

    const cues = changeoverCues(
      lines.map((l) => l.text),
      listening,
      plan,
    );
    if (!cues.length) return;

    // the room's turn, then the day's allowance
    const turn = await this.redis.set(
      `switch:asked:${roomKey(plan.room)}`,
      '1',
      'PX',
      ROOM_GAP_MS,
      'NX',
    );
    if (turn !== 'OK') return;
    const day = lagosMidnight(now).toISOString().slice(0, 10);
    const used = await this.redis.incr(`switch:calls:${day}`);
    if (used === 1) await this.redis.expire(`switch:calls:${day}`, 2 * 86_400);
    if (used > this.dailyCap) {
      if (this.capWarned !== day) {
        this.capWarned = day;
        this.logger.warn(
          `switch suggestions: today's ${this.dailyCap} AI checks are used up`,
        );
      }
      return;
    }

    const answer = await this.suggester.judge(plan, lines, now);
    this.logger.log(
      `${plan.room}: listening for ${listening}, cues ${cues.join('; ')} -> ${answer ? `${answer.verdict} ${answer.confidence}` : 'no answer'}`,
    );
    if (!answer) return;
    const verdict = cleanVerdict(answer, plan, lines, MIN_CONFIDENCE);
    if (!verdict) return;

    const toSessionId =
      verdict.kind === 'start_next' ? (plan.next?.id ?? null) : null;
    const quiet = await this.suggestions.count({
      where: {
        room: plan.room,
        kind: verdict.kind,
        fromSessionId: plan.live.id,
        status: 'dismissed',
        decidedAt: MoreThanOrEqual(
          new Date(now.getTime() - DISMISSED_QUIET_MS),
        ),
      },
    });
    if (quiet) return;
    if (
      await this.suggestions.count({
        where: { room: plan.room, status: 'open' },
      })
    )
      return;

    await this.suggestions.save(
      this.suggestions.create({
        room: plan.room,
        kind: verdict.kind,
        fromSessionId: plan.live.id,
        toSessionId,
        confidence: verdict.confidence,
        evidence: verdict.evidence,
        reason: verdict.reason,
        status: 'open',
      }),
    );
    this.realtime.emitGlobal('switch:suggestions', { room: plan.room });
  }

  /** What Live ops shows: whether it is on, the open suggestions, and today's tally. */
  async list(now = new Date()) {
    const open = this.enabled
      ? await this.suggestions.find({
          where: { status: 'open' },
          order: { createdAt: 'ASC' },
        })
      : [];
    const today = await this.suggestions.find({
      where: { createdAt: MoreThanOrEqual(lagosMidnight(now)) },
      select: { status: true },
    });
    const n = (...statuses: SwitchSuggestion['status'][]) =>
      today.filter((s) => statuses.includes(s.status)).length;
    return {
      enabled: this.enabled,
      open,
      today: {
        right: n('accepted', 'matched'),
        wrong: n('dismissed'),
        unanswered: n('expired'),
      },
    };
  }

  /** A person switched from it, or said not yet. */
  async decide(id: string, status: 'accepted' | 'dismissed', now = new Date()) {
    const s = await this.suggestions.findOneBy({ id });
    if (!s) throw new NotFoundException('Suggestion not found');
    if (s.status === 'open') {
      await this.suggestions.update(id, { status, decidedAt: now });
      this.realtime.emitGlobal('switch:suggestions', { room: s.room });
    }
    return this.list(now);
  }
}
