import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { AgendaCheckService } from '../../captions/agenda-check/agenda-check.service';
import { CaptionsService } from '../../captions/captions.service';
import { SpeakerNamesService } from '../../captions/speaker-names/speaker-names.service';
import { REDIS } from '../../common/redis/redis.module';
import { CallsToActionService } from '../calls-to-action.service';
import {
  lagosClock,
  minutesOf,
  splitFixes,
  type NightlyResult,
} from './nightly-tidy';

const CHECK_MS = 5 * 60_000;
const KEEP_S = 4 * 24 * 3600;
const resultKey = (editionId: string, day: number) =>
  `nightly:result:${editionId}:${day}`;

/**
 * Tidies the day overnight (see nightly-tidy.ts): at NIGHTLY_TIDY_AT Abuja
 * time (23:00 unless set), on one API instance, once a day. NIGHTLY_TIDY=off
 * turns it off; an admin can also run it for a day from the console.
 */
@Injectable()
export class NightlyTidyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightlyTidyService.name);
  private readonly enabled: boolean;
  private readonly at: number;
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly agenda: AgendaCheckService,
    private readonly captions: CaptionsService,
    private readonly names: SpeakerNamesService,
    private readonly calls: CallsToActionService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.enabled =
      config.get<string>('NIGHTLY_TIDY')?.trim().toLowerCase() !== 'off';
    this.at = minutesOf(config.get<string>('NIGHTLY_TIDY_AT'));
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs tonight's tidy once the hour comes, on whichever instance claims it first. */
  async tick(now = new Date()): Promise<void> {
    try {
      const { date, minutes } = lagosClock(now);
      if (minutes < this.at) return;
      const claimed = await this.redis.set(
        `nightly:claimed:${date}`,
        '1',
        'EX',
        2 * 24 * 3600,
        'NX',
      );
      if (claimed !== 'OK') return;
      const edition = await this.currentEdition();
      const day = edition ? await this.dayOn(edition, date) : null;
      if (!edition || day === null) return;
      this.logger.log(`overnight tidy for day ${day} (${date}) starting`);
      await this.run(edition, day, date);
    } catch (error) {
      this.logger.warn(`overnight tidy failed: ${(error as Error).message}`);
    }
  }

  /** The last result for a day, or null when none has run. */
  async result(editionId: string, day: number): Promise<NightlyResult | null> {
    const raw = await this.redis.get(resultKey(editionId, day));
    return raw ? (JSON.parse(raw) as NightlyResult) : null;
  }

  /** An admin's run now; the console reads the result as it goes. */
  async runNow(editionId: string, day: number): Promise<{ started: boolean }> {
    const running = await this.redis.set(
      `nightly:running:${editionId}:${day}`,
      '1',
      'EX',
      3 * 3600,
      'NX',
    );
    if (running !== 'OK') return { started: false };
    void this.run(editionId, day, lagosClock(new Date()).date)
      .catch((e: Error) =>
        this.logger.warn(`tidy of day ${day} failed: ${e.message}`),
      )
      .finally(
        () => void this.redis.del(`nightly:running:${editionId}:${day}`),
      );
    return { started: true };
  }

  async run(
    editionId: string,
    day: number,
    date: string,
  ): Promise<NightlyResult> {
    const result: NightlyResult = {
      editionId,
      day,
      date,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      moved: [],
      toReview: [],
      roomsChecked: 0,
      roomsFailed: [],
      namesAdded: 0,
      analysed: 0,
      newSuggestions: 0,
      speakersFilled: 0,
      failures: 0,
    };
    const save = () =>
      this.redis.set(
        resultKey(editionId, day),
        JSON.stringify(result),
        'EX',
        KEEP_S,
      );
    await save();

    // 1. each room against the agenda; sure mix-ups moved
    const touched = new Set<string>();
    for (const room of await this.roomsOf(editionId, day)) {
      try {
        const check = await this.agenda.run(editionId, day, room);
        result.roomsChecked++;
        const { auto, review } = splitFixes(check.fixes);
        result.toReview.push(...review);
        for (const fix of auto) {
          try {
            const r = await this.captions.moveCaptions(
              fix.fromSessionId,
              fix.toSessionId!,
              new Date(fix.since),
              new Date(fix.until),
            );
            result.moved.push({ ...fix, movedLines: r.moved });
            touched.add(fix.fromSessionId);
            touched.add(fix.toSessionId!);
          } catch (e) {
            result.toReview.push({
              ...fix,
              why: `Not moved: ${(e as Error).message}`,
            });
          }
        }
      } catch {
        result.roomsFailed.push(room);
      }
      await save();
    }

    const sessions = await this.sessionsWithCaptions(editionId, day);
    // 2. voices named
    for (const id of sessions) {
      try {
        result.namesAdded += (
          await this.names.runReview({ sessionId: id })
        ).added;
      } catch {
        result.failures++;
      }
    }
    await save();
    // 3. analysed: the moved ones read afresh, the rest for whatever is new
    for (const id of sessions) {
      try {
        const r = await this.calls.analyse(id, touched.has(id));
        result.analysed++;
        result.newSuggestions += r.added.length;
      } catch {
        result.failures++;
      }
    }
    await save();
    // 4. who said each call
    for (const id of sessions) {
      try {
        result.speakersFilled += (await this.calls.fillWhoSaid(id)).filled;
      } catch {
        result.failures++;
      }
    }
    result.finishedAt = new Date().toISOString();
    await save();
    this.logger.log(
      `tidy of day ${day}: ${result.moved.length} moved, ${result.toReview.length} to review, ${result.newSuggestions} new suggestions, ${result.speakersFilled} speakers found`,
    );
    return result;
  }

  private async currentEdition(): Promise<string | null> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM editions WHERE "isCurrent" = true LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  /** The programme day falling on a date, in Abuja. */
  private async dayOn(editionId: string, date: string): Promise<number | null> {
    const rows = await this.dataSource.query<{ day: number }[]>(
      `SELECT day FROM sessions
        WHERE "editionId" = $1 AND to_char("startsAt" AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') = $2
        GROUP BY day ORDER BY count(*) DESC LIMIT 1`,
      [editionId, date],
    );
    return rows[0]?.day ?? null;
  }

  private async roomsOf(editionId: string, day: number): Promise<string[]> {
    const rows = await this.dataSource.query<{ room: string }[]>(
      `SELECT DISTINCT TRIM(room) AS room FROM sessions WHERE "editionId" = $1 AND day = $2 AND TRIM(room) <> ''`,
      [editionId, day],
    );
    return rows.map((r) => r.room).sort();
  }

  /** The day's sessions that hold captions, whatever their status. */
  private async sessionsWithCaptions(
    editionId: string,
    day: number,
  ): Promise<string[]> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT s.id FROM sessions s
        WHERE s."editionId" = $1 AND s.day = $2
          AND EXISTS (SELECT 1 FROM transcript_segments t WHERE t."sessionId" = s.id::text AND t.language = 'en')
        ORDER BY s."startsAt"`,
      [editionId, day],
    );
    return rows.map((r) => r.id);
  }
}
