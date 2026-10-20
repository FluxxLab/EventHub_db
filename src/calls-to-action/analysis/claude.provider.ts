import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type {
  AnalysisContext,
  AnalysisLine,
  AnalysisProvider,
  FoundCallToAction,
} from './analysis.provider';

/** ANALYSIS_MODEL picks another. */
const DEFAULT_MODEL = 'claude-opus-5-5';

const INSTRUCTIONS = `You read the transcript of one session of a policy summit in Nigeria and list its calls to action.

A call to action is something a speaker says should be done, with someone to do it:
- a recommendation: an organisation or group should act ("Government must make disaggregated data mandatory", "We call on banks to set aside 30% of SME lending for women");
- a pledge: the speaker's own organisation will act ("Our ministry will fund 500 shelters by 2027").

Leave out general statements ("inclusion matters"), questions, anecdotes, thanks, and problems described with no action to take. A call that is real but too vague to act on ("the private sector needs to step up") stays in, with needsDetail set to true, so a reviewer can sharpen or drop it.

Organisers review every item before it goes into the summit's call-to-action deck, so stay faithful to what was said: never add an amount, deadline, organisation or action that the transcript does not contain.

For each one:
- action: the full action in plain words.
- shortText: the slide version, at most 25 words, leading with the action ("Fund 500 GBV shelters across the six zones by 2027").
- directedAt: who is called on to commit. Use a name from TARGETS when one fits exactly, otherwise the organisation or group as said. For a pledge, the speaker's own organisation.
- proposedBy: the speaker's name from the transcript line, or null when the line is "Mic N", "Speaker N" or Unknown. proposedByOrganisation: theirs from SPEAKERS, else null.
- deadline and amount: as said, or null.
- theme: a few words for the topic, or null.
- quote: the exact words it rests on, copied from the transcript (one or two sentences).
- line: the number of the line the quote is on.

SESSION BRIEF, when given, is what the organisers asked the session to address. Use it to understand the subject, the terms and who the session is aimed at, and to set theme. It is not a source of calls to action: record only what a speaker actually said in the transcript, never an aim from the brief that nobody voiced.

Skip anything already listed under ALREADY RECORDED. Return an empty list when there are none.`;

/** The answer's shape; the API holds the model to it. */
const Found = z.object({
  callsToAction: z.array(
    z.object({
      type: z.enum(['recommendation', 'pledge']),
      action: z.string(),
      shortText: z.string(),
      directedAt: z.string(),
      proposedBy: z.string().nullable(),
      proposedByOrganisation: z.string().nullable(),
      deadline: z.string().nullable(),
      amount: z.string().nullable(),
      theme: z.string().nullable(),
      quote: z.string(),
      line: z.number().int(),
      needsDetail: z.boolean(),
    }),
  ),
});

const hms = (d: Date) => d.toISOString().slice(11, 19);

/** The transcript and its context as the model reads them. */
export function analysisPrompt(
  lines: AnalysisLine[],
  context: AnalysisContext,
): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '(none)';
  return [
    `EVENT: ${context.event}`,
    `SESSION: ${context.session}`,
    ...(context.brief?.trim()
      ? [`SESSION BRIEF:\n${context.brief.trim()}`]
      : []),
    `SPEAKERS:\n${list(context.speakers)}`,
    `TARGETS:\n${list(context.targets)}`,
    `ALREADY RECORDED:\n${list(context.alreadyRecorded)}`,
    `TRANSCRIPT:\n${lines
      .map((l) => `L${l.n} [${hms(l.at)}] ${l.who ?? 'Unknown'}: ${l.text}`)
      .join('\n')}`,
  ].join('\n\n');
}

/**
 * What the model found, trimmed to the columns' sizes; an item missing its
 * action, target or quote is dropped rather than saved half-filled.
 */
export function cleanFound(
  items: z.infer<typeof Found>['callsToAction'],
  lineCount: number,
): FoundCallToAction[] {
  const text = (v: string | null | undefined, max: number) =>
    v?.trim() ? v.trim().slice(0, max) : null;
  const out: FoundCallToAction[] = [];
  for (const item of items) {
    const action = text(item.action, 2000);
    const directedAt = text(item.directedAt, 200);
    const quote = text(item.quote, 2000);
    if (!action || !directedAt || !quote) continue;
    out.push({
      type: item.type,
      action,
      shortText: text(item.shortText, 200) ?? action.slice(0, 200),
      directedAt,
      proposedBy: text(item.proposedBy, 200),
      proposedByOrganisation: text(item.proposedByOrganisation, 200),
      deadline: text(item.deadline, 120),
      amount: text(item.amount, 120),
      theme: text(item.theme, 120),
      quote,
      line: item.line >= 1 && item.line <= lineCount ? item.line : 0,
      needsDetail: item.needsDetail,
    });
  }
  return out;
}

/**
 * Claude reads the session's named transcript and answers in a fixed JSON
 * shape. A request the model declines is rerun server-side on Anthropic's
 * recommended fallback (`fallbacks: "default"`); a decline of the whole chain
 * is reported, never guessed around.
 */
@Injectable()
export class ClaudeAnalysisProvider implements AnalysisProvider {
  private readonly logger = new Logger(ClaudeAnalysisProvider.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    // A whole session at high effort can take a minute or two; Analyse waits.
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 300_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('ANALYSIS_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  async find(
    lines: AnalysisLine[],
    context: AnalysisContext,
  ): Promise<FoundCallToAction[]> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'AI analysis is not set up yet: add ANTHROPIC_API_KEY on the server.',
      );
    }
    let response: Awaited<ReturnType<ClaudeAnalysisProvider['request']>>;
    try {
      response = await this.request(this.client, lines, context);
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new ServiceUnavailableException(
          'The AI is busy right now. Try again in a minute.',
        );
      }
      if (error instanceof Anthropic.AuthenticationError) {
        this.logger.error('Claude rejected ANTHROPIC_API_KEY');
        throw new ServiceUnavailableException(
          'The AI key on the server was refused. Check ANTHROPIC_API_KEY.',
        );
      }
      if (error instanceof Anthropic.APIError) {
        this.logger.warn(`Claude ${error.status}: ${error.message}`);
        throw new ServiceUnavailableException(
          'The AI could not analyse the session. Try again shortly.',
        );
      }
      throw error;
    }
    if (response.stop_reason === 'refusal') {
      this.logger.warn(
        `analysis declined (${response.stop_details?.category ?? 'no category'})`,
      );
      throw new ServiceUnavailableException(
        'The AI declined to analyse this transcript. Add the calls to action by hand.',
      );
    }
    const found = response.parsed_output;
    if (!found) {
      this.logger.warn(
        `analysis answered without the expected shape (stop: ${response.stop_reason})`,
      );
      return [];
    }
    return cleanFound(found.callsToAction, lines.length);
  }
  /** One request: the whole stretch of transcript, answered in the `Found` shape. */
  private request(
    client: Anthropic,
    lines: AnalysisLine[],
    context: AnalysisContext,
  ) {
    return client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: analysisPrompt(lines, context) }],
      output_config: {
        // careful reading matters more than speed here: high, not the medium default
        effort: 'high',
        format: betaZodOutputFormat(Found),
      },
    });
  }
}
