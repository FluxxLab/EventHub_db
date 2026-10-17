import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { ProgrammeSpeaker, ReviewFinding } from './speaker-naming-plan';

/** SPEAKER_MODEL picks another; introductions are short, so the small model. */
const DEFAULT_MODEL = 'claude-haiku-5-5';

const INTRO_INSTRUCTIONS = `You are a careful editor of a live conference transcript, in British English. You are shown a few consecutive caption lines from one session; the line marked >>> may be someone introducing themselves, or introducing the person who will speak next.

Answer with kind:
- "self": the person speaking that line gives their own name ("My name is Amina Bello", "I'm Dr Okafor from the Ministry of Health", "Chinedu Eze speaking, on behalf of the chamber").
- "third-party": the speaker introduces someone else who is about to speak ("Please welcome Dr Amina Bello", "I'll hand over to our next speaker, Professor Eze", "Over to you, Ngozi").
- "none": anything else - a quotation, "my name is on the list", a list of names, a joke, thanks to someone who is not about to speak, a name mentioned in passing, a welcome with no name, a greeting.

Names come from speech recognition and may be misspelt, split or run together. When the name clearly refers to one of the PROGRAMME speakers (allowing for mis-transcription), give that speaker's id as programmeSpeakerId and their name exactly as listed. Otherwise leave programmeSpeakerId null and give the name as well as it can be read, with its title kept (Dr, Prof, Hon.). organisation: the organisation given on the line, else the programme speaker's, else null. confidence: 0 to 1, how sure you are of both the kind and the name; be strict, a wrong name on screen is worse than none. reason: one short sentence.`;

const Intro = z.object({
  kind: z.enum(['self', 'third-party', 'none']),
  name: z.string().nullable(),
  organisation: z.string().nullable(),
  programmeSpeakerId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});
export type IntroAnswer = z.infer<typeof Intro>;

const REVIEW_INSTRUCTIONS = `You are a careful editor of a conference session's transcript, in British English. Each line is numbered and labelled with the voice ("Speaker 3") or microphone ("Mic 2") it came from, and the name currently attached to it where one is ("Speaker 3 (Dr Amina Bello)"; a question mark marks a suggestion nobody has confirmed). A voice number identifies one voice only within one run of the recording: the numbering restarts from 0 whenever the stream reopened, so the same number can be different people in different stretches. A mic can change hands between people.

Work out who was speaking on each voice or mic, and for which stretch of lines, from self-introductions, the chair's introductions and handovers, people being addressed or thanked by name, and the PROGRAMME. Return one binding per stretch: kind ("speaker" or "mic"), key (the number), name (the programme spelling when it is clearly the same person, else as said, with titles kept), organisation (or null), programmeSpeakerId (the programme speaker's id, or null), fromLine and toLine (inclusive, 1-based line numbers), confidence (0 to 1). Only return bindings you are reasonably sure of; a wrong name is worse than none. Leave out stretches that CURRENT BINDINGS already name correctly; include one for a stretch they name wrongly. Return an empty list when nothing can be told.`;

const Review = z.object({
  bindings: z.array(
    z.object({
      kind: z.enum(['speaker', 'mic']),
      key: z.number().int(),
      name: z.string(),
      organisation: z.string().nullable(),
      programmeSpeakerId: z.string().nullable(),
      fromLine: z.number().int(),
      toLine: z.number().int(),
      confidence: z.number(),
    }),
  ),
});

/** One caption line as the model reads it. */
export interface NamerLine {
  /** "Mic 2", "Speaker 3 (Dr Amina Bello)", "Unknown". */
  who: string;
  text: string;
  /** hh:mm:ss, when it was said. */
  at: string;
}

export interface IntroContext {
  session: string;
  speakers: ProgrammeSpeaker[];
  before: NamerLine[];
  line: NamerLine;
  after: NamerLine[];
}

export interface ReviewContext {
  session: string;
  speakers: ProgrammeSpeaker[];
  /** "Speaker 3, lines 12-80: Dr Amina Bello (confirmed)". */
  bindings: string[];
  /** Numbered from `firstLine`, so a chunk keeps the session's numbering. */
  firstLine: number;
  totalLines: number;
  lines: NamerLine[];
}

const list = (items: string[]) =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : '(none)';

const speakerList = (speakers: ProgrammeSpeaker[]) =>
  list(
    speakers.map(
      (s) =>
        `${s.id}: ${s.name}${s.organisation ? ` (${s.organisation})` : ''}`,
    ),
  );

/** The lines around a candidate, the candidate marked. */
export function introPrompt(ctx: IntroContext): string {
  const line = (l: NamerLine, mark = '   ') =>
    `${mark} [${l.at}] ${l.who}: ${l.text}`;
  return [
    `SESSION: ${ctx.session}`,
    `PROGRAMME:\n${speakerList(ctx.speakers)}`,
    `LINES:\n${[
      ...ctx.before.map((l) => line(l)),
      line(ctx.line, '>>>'),
      ...ctx.after.map((l) => line(l)),
    ].join('\n')}`,
  ].join('\n\n');
}

/** The session's transcript, numbered and labelled, with what is known. */
export function reviewPrompt(ctx: ReviewContext): string {
  return [
    `SESSION: ${ctx.session}`,
    `PROGRAMME:\n${speakerList(ctx.speakers)}`,
    `CURRENT BINDINGS:\n${list(ctx.bindings)}`,
    `TRANSCRIPT (lines ${ctx.firstLine}-${ctx.firstLine + ctx.lines.length - 1} of ${ctx.totalLines}):\n${ctx.lines
      .map((l, i) => `L${ctx.firstLine + i} [${l.at}] ${l.who}: ${l.text}`)
      .join('\n')}`,
  ].join('\n\n');
}

/**
 * Claude reads an introduction, or a whole session, and says who is who.
 * Returns null, never throws, when it is not set up or cannot answer: a
 * name that cannot be heard is simply not applied.
 */
@Injectable()
export class ClaudeSpeakerNamer {
  private readonly logger = new Logger(ClaudeSpeakerNamer.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('SPEAKER_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  /** Is the marked line an introduction, and of whom? */
  async identify(ctx: IntroContext): Promise<IntroAnswer | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 600,
        system: INTRO_INSTRUCTIONS,
        messages: [{ role: 'user', content: introPrompt(ctx) }],
        output_config: {
          // a few lines and a short answer: the quick setting is enough
          effort: 'low',
          format: betaZodOutputFormat(Intro),
        },
      });
      if (response.stop_reason === 'refusal') return null;
      if (!response.parsed_output) {
        this.logger.warn(
          `introduction answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return null;
      }
      return response.parsed_output;
    } catch (error) {
      this.logger.warn(`introduction check failed: ${describe(error)}`);
      return null;
    }
  }

  /** Who spoke when, across a stretch of the session. */
  async review(ctx: ReviewContext): Promise<ReviewFinding[] | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 8000,
        system: REVIEW_INSTRUCTIONS,
        messages: [{ role: 'user', content: reviewPrompt(ctx) }],
        output_config: {
          effort: 'medium',
          format: betaZodOutputFormat(Review),
        },
      });
      if (response.stop_reason === 'refusal') return null;
      if (!response.parsed_output) {
        this.logger.warn(
          `review answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return null;
      }
      return response.parsed_output.bindings;
    } catch (error) {
      this.logger.warn(`speaker review failed: ${describe(error)}`);
      return null;
    }
  }
}

const describe = (error: unknown) =>
  error instanceof Anthropic.APIError
    ? `${error.status} ${error.message}`
    : (error as Error).message;
