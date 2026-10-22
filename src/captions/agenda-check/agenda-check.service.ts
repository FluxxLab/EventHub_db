import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { REDIS } from '../../common/redis/redis.module';
import { CaptionsService } from '../captions.service';
import { TranscriptSegment } from '../entities/transcript-segment.entity';
import { seqOf } from '../segment-time';
import {
  AGENDA_INSTRUCTIONS,
  AgendaAnswer,
  agendaPrompt,
  cleanAnswer,
  toTurns,
  type AgendaFit,
  type AgendaFix,
  type AgendaSession,
  type FiledLine,
} from './agenda-check';

const DEFAULT_MODEL = 'claude-opus-5-5';
/** A result is kept this long for the console to collect. */
const KEEP_S = 60 * 60;

export type AgendaCheckResult = {
  room: string;
  day: number;
  sessions: { id: string; title: string; startsAt: string; lines: number }[];
  fits: AgendaFit[];
  fixes: AgendaFix[];
};

export type AgendaCheckJob =
  | { status: 'running' }
  | { status: 'done'; result: AgendaCheckResult }
  | { status: 'failed'; error: string };

/**
 * Reads a room's day of captions against its agenda with Claude and suggests
 * moves for stretches filed under the wrong session. Runs in the background
 * (a long day takes a minute or two); the result waits in Redis, so either
 * API replica can hand it back.
 */
@Injectable()
export class AgendaCheckService {
  private readonly logger = new Logger(AgendaCheckService.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(
    config: ConfigService,
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    private readonly captions: CaptionsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 600_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('ANALYSIS_MODEL')?.trim() || DEFAULT_MODEL;
  }

  async start(
    editionId: string,
    day: number,
    room: string,
  ): Promise<{ jobId: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'AI is not set up yet: add ANTHROPIC_API_KEY on the server.',
      );
    }
    const jobId = randomUUID();
    await this.save(jobId, { status: 'running' });
    void this.run(editionId, day, room)
      .then((result) => this.save(jobId, { status: 'done', result }))
      .catch((error: Error) => {
        this.logger.warn(
          `agenda check failed for ${room}, day ${day}: ${error.message}`,
        );
        return this.save(jobId, { status: 'failed', error: error.message });
      });
    return { jobId };
  }

  async job(jobId: string): Promise<AgendaCheckJob> {
    const raw = await this.redis.get(`agenda-check:${jobId}`);
    if (!raw)
      throw new NotFoundException('That check has expired. Run it again.');
    return JSON.parse(raw) as AgendaCheckJob;
  }

  private save(jobId: string, job: AgendaCheckJob) {
    return this.redis.set(
      `agenda-check:${jobId}`,
      JSON.stringify(job),
      'EX',
      KEEP_S,
    );
  }

  /** The room's agenda for the day, speakers and the start of each brief included. */
  private async agenda(
    editionId: string,
    day: number,
    room: string,
  ): Promise<AgendaSession[]> {
    const rows = await this.segments.manager.query<
      (Omit<AgendaSession, 'startsAt' | 'endsAt'> & {
        startsAt: string | Date;
        endsAt: string | Date;
      })[]
    >(
      `SELECT s.id, s.title, s.type, s.status, s."startsAt", s."endsAt", LEFT(s.brief, 600) AS brief,
              COALESCE(json_agg(json_build_object('name', sp.name, 'organisation', sp.organisation))
                       FILTER (WHERE sp.id IS NOT NULL), '[]') AS speakers
         FROM sessions s
         LEFT JOIN session_speakers ss ON ss."sessionsId" = s.id
         LEFT JOIN speakers sp ON sp.id = ss."speakersId"
        WHERE s."editionId" = $1 AND s.day = $2 AND LOWER(TRIM(s.room)) = LOWER(TRIM($3))
        GROUP BY s.id
        ORDER BY s."startsAt"`,
      [editionId, day, room],
    );
    return rows.map((r) => ({
      ...r,
      startsAt: new Date(r.startsAt),
      endsAt: new Date(r.endsAt),
    }));
  }

  async run(
    editionId: string,
    day: number,
    room: string,
  ): Promise<AgendaCheckResult> {
    const agenda = await this.agenda(editionId, day, room);
    // every session with captions: one never switched on can hold them too (captions follow the programme)
    const lines: FiledLine[] = [];
    const counts = new Map<string, number>();
    for (const s of agenda) {
      const rows = await this.captions.fullTranscript(s.id);
      counts.set(s.id, rows.length);
      for (const r of rows)
        lines.push({
          sessionId: s.id,
          at: seqOf(r),
          name: r.name,
          text: r.text,
        });
    }
    const base = {
      room,
      day,
      sessions: agenda
        .filter((s) => s.status !== 'scheduled' || (counts.get(s.id) ?? 0) > 0)
        .map((s) => ({
          id: s.id,
          title: s.title,
          startsAt: s.startsAt.toISOString(),
          lines: counts.get(s.id) ?? 0,
        })),
    };
    const turns = toTurns(lines);
    if (!turns.length) return { ...base, fits: [], fixes: [] };

    const response = await this.client!.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: AGENDA_INSTRUCTIONS,
      messages: [
        { role: 'user', content: agendaPrompt(room, day, agenda, turns) },
      ],
      output_config: {
        effort: 'medium',
        format: betaZodOutputFormat(AgendaAnswer),
      },
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error('The AI could not check this room. Try again.');
    }
    const { fits, fixes } = cleanAnswer(response.parsed_output, agenda, turns);
    this.logger.log(
      `agenda check ${room}, day ${day}: ${turns.length} turns, ${fixes.length} fix(es) suggested`,
    );
    return { ...base, fits, fixes };
  }
}
