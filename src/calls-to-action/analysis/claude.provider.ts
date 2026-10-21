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
import {
  cleanWho,
  nameIsGrounded,
  WHO_INSTRUCTIONS,
  WhoAnswer,
  whoPrompt,
  type WhoItem,
} from './who-said-it';

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
- proposedBy: who said it. When the line carries a name, that name. When it is only a voice ("Speaker N", "Mic N", Unknown), find the person in the transcript: a host or moderator introducing them ("please welcome…", "over to you, Dr…"), the speaker introducing themselves ("my name is…"), the same voice continuing after such an introduction, or thanks afterwards ("thank you, Professor…"). Use SPEAKERS to complete the name, never on its own to guess. null when the transcript does not show who it was; a wrong name is worse than none. proposedByOrganisation: theirs from the transcript or SPEAKERS, else null.
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

/** Lower case, accents and punctuation gone, single spaces: how a quote and a caption are compared. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Share of a quote's words found in a stretch of transcript (each transcript word used once). */
function coverage(quoteWords: string[], text: string): number {
  const bag = new Map<string, number>();
  for (const w of text.split(' ')) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of quoteWords) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      bag.set(w, n - 1);
      hit += 1;
    }
  }
  return quoteWords.length ? hit / quoteWords.length : 0;
}

/**
 * The line a quote was said on, or null when it was not said.
 *
 * Every call to action has to rest on words a speaker said; a quote that is
 * not in the transcript means the model drew the call from somewhere else
 * (the session brief, the description, its own knowledge) and it is
 * dropped. The model may tidy punctuation or quote across a caption break,
 * so a quote counts as said when 80% of its words are in the cited line and
 * its neighbours, or anywhere three lines together when the cited line is
 * wrong. A quote of three words or fewer must appear as written.
 */
export function quoteLine(
  quote: string,
  lines: AnalysisLine[],
  cited: number,
): number | null {
  const q = plain(quote);
  if (!q || lines.length === 0) return null;
  const words = q.split(' ');
  const around = (i: number) =>
    plain(
      lines
        .slice(Math.max(0, i - 1), i + 2)
        .map((l) => l.text)
        .join(' '),
    );
  const said = (i: number) => {
    const text = around(i);
    if (` ${text} `.includes(` ${q} `)) return true;
    return words.length > 3 && coverage(words, text) >= 0.8;
  };
  if (cited >= 1 && cited <= lines.length && said(cited - 1)) return cited;
  for (let i = 0; i < lines.length; i += 1) {
    if (!said(i)) continue;
    // the line of the three that holds most of the quote
    const best = [i - 1, i, i + 1]
      .filter((j) => j >= 0 && j < lines.length)
      .sort(
        (a, b) =>
          coverage(words, plain(lines[b].text)) -
          coverage(words, plain(lines[a].text)),
      )[0];
    return best + 1;
  }
  return null;
}

/**
 * What the model found, trimmed to the columns' sizes. An item missing its
 * action, target or quote is dropped rather than saved half-filled, and so
 * is one whose quote is not in the transcript (see quoteLine).
 */
export function cleanFound(
  items: z.infer<typeof Found>['callsToAction'],
  lines: AnalysisLine[],
  speakers: string[] = [],
): FoundCallToAction[] {
  const text = (v: string | null | undefined, max: number) =>
    v?.trim() ? v.trim().slice(0, max) : null;
  const out: FoundCallToAction[] = [];
  for (const item of items) {
    const action = text(item.action, 2000);
    const directedAt = text(item.directedAt, 200);
    const quote = text(item.quote, 2000);
    if (!action || !directedAt || !quote) continue;
    const line = quoteLine(quote, lines, item.line);
    if (line === null) continue;
    // a name nobody said and the programme does not list is dropped, not the call
    const by = text(item.proposedBy, 200);
    const grounded = by && nameIsGrounded(by, lines, speakers) ? by : null;
    out.push({
      type: item.type,
      action,
      shortText: text(item.shortText, 200) ?? action.slice(0, 200),
      directedAt,
      proposedBy: grounded,
      proposedByOrganisation: grounded
        ? text(item.proposedByOrganisation, 200)
        : null,
      deadline: text(item.deadline, 120),
      amount: text(item.amount, 120),
      theme: text(item.theme, 120),
      quote,
      line,
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
    const clean = cleanFound(found.callsToAction, lines, context.speakers);
    const dropped = found.callsToAction.length - clean.length;
    if (dropped > 0) {
      this.logger.warn(
        `analysis: ${dropped} of ${found.callsToAction.length} dropped (incomplete, or quote not in the transcript)`,
      );
    }
    return clean;
  }
  /**
   * Who said each of a session's calls, from the transcript (see who-said-it).
   * Only grounded, confident answers come back; a failure is no answers.
   */
  async whoSaid(
    session: string,
    speakers: string[],
    lines: AnalysisLine[],
    items: WhoItem[],
  ): Promise<Map<string, { name: string; organisation: string | null }>> {
    if (!this.client || !items.length) return new Map();
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: WHO_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: whoPrompt(session, speakers, lines, items),
          },
        ],
        output_config: {
          effort: 'medium',
          format: betaZodOutputFormat(WhoAnswer),
        },
      });
      if (!response.parsed_output) return new Map();
      return cleanWho(
        response.parsed_output,
        new Set(items.map((i) => i.ref)),
        lines,
        speakers,
      );
    } catch (error) {
      this.logger.warn(`who said it failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'The AI could not read this session right now. Try again shortly.',
      );
    }
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
