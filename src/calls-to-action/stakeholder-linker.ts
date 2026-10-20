import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const DEFAULT_MODEL = 'claude-opus-5-5';

export const LINK_INSTRUCTIONS = `Calls to action from a policy and technology conference in Nigeria are sometimes aimed at a broad group ("Federal Government", "Development partners", "Private sector") rather than one organisation. You link each broad target to the organisations attending the event that clearly belong to it, so organisers know whom to approach.

Rules:
- Use only organisations from ORGANISATIONS, copied exactly as written there. Never invent or rename one.
- Link an organisation only when it plainly belongs to the group: a federal ministry, department or agency to "Federal Government"; a company to "Private sector"; a multilateral bank, foundation or donor agency to "Development partners"; a university or research institute to "Academia"; a newspaper or broadcaster to "Media"; an NGO or advocacy group to "Civil society organisations". Use the example calls to understand what each target means.
- When unsure, leave it out: organisers confirm every link, and a short accurate list helps them more than a long one.
- For each link give a short reason (under 15 words), e.g. "Federal agency under the Ministry of Communications".
- A target that no attending organisation belongs to gets no links.`;

const Answer = z.object({
  links: z.array(
    z.object({
      target: z.string(),
      organisation: z.string(),
      reason: z.string(),
    }),
  ),
});

export type LinkRequest = {
  event: string;
  /** Broad targets, each with a few of the calls aimed at it. */
  targets: { target: string; examples: string[] }[];
  /** The event's organisations, as their delegates wrote them. */
  organisations: string[];
};

export type SuggestedLink = {
  target: string;
  organisation: string;
  reason: string;
};

/** The user turn: the targets with example calls, then the organisations. */
export function linkPrompt(request: LinkRequest): string {
  return [
    `EVENT: ${request.event}`,
    'TARGETS:',
    ...request.targets.map(
      (t) =>
        `- ${t.target}${t.examples.length ? `\n  e.g. ${t.examples.map((e) => `"${e}"`).join('; ')}` : ''}`,
    ),
    '',
    'ORGANISATIONS:',
    ...request.organisations.map((o) => `- ${o}`),
  ].join('\n');
}

/**
 * What the model answered, kept only where the target and organisation are
 * ones it was given (matched exactly, case aside), once per pair, with the
 * reason trimmed to its column.
 */
export function cleanLinks(
  answer: z.infer<typeof Answer>['links'],
  request: LinkRequest,
): SuggestedLink[] {
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const targets = new Map(
    request.targets.map((t) => [key(t.target), t.target]),
  );
  const orgs = new Map(request.organisations.map((o) => [key(o), o]));
  const seen = new Set<string>();
  const out: SuggestedLink[] = [];
  for (const l of answer) {
    const target = targets.get(key(l.target));
    const organisation = orgs.get(key(l.organisation));
    if (!target || !organisation) continue;
    const pair = `${key(target)}|${key(organisation)}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({
      target,
      organisation,
      reason: l.reason.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
  return out;
}

/** Asks Claude which of the event's organisations fall under each broad target. */
@Injectable()
export class ClaudeStakeholderLinker {
  private readonly logger = new Logger(ClaudeStakeholderLinker.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('ANALYSIS_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  /** The suggested links, or the reason there are none to show. */
  async suggest(
    request: LinkRequest,
  ): Promise<{ links: SuggestedLink[]; reason: string | null }> {
    if (!this.client)
      return { links: [], reason: 'The AI is not set up on the server.' };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: LINK_INSTRUCTIONS,
        messages: [{ role: 'user', content: linkPrompt(request) }],
        output_config: { effort: 'low', format: betaZodOutputFormat(Answer) },
      });
      if (response.stop_reason === 'refusal')
        return { links: [], reason: 'The AI declined to suggest links.' };
      if (!response.parsed_output) {
        this.logger.warn(
          `stakeholder links answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return { links: [], reason: 'The AI answer came back incomplete.' };
      }
      const links = cleanLinks(response.parsed_output.links, request);
      const dropped = response.parsed_output.links.length - links.length;
      if (dropped > 0)
        this.logger.warn(
          `stakeholder links: ${dropped} dropped (organisation or target not in the list)`,
        );
      return { links, reason: null };
    } catch (error) {
      this.logger.warn(
        `stakeholder links failed: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : (error as Error).message}`,
      );
      return {
        links: [],
        reason:
          error instanceof Anthropic.RateLimitError
            ? 'The AI is busy right now. Try again in a minute.'
            : 'The AI could not suggest links just now.',
      };
    }
  }
}
