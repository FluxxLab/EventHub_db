import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TOP_BRIEF_INSTRUCTIONS,
  TopBriefAnswer,
  topBriefPrompt,
  type BriefCall,
} from './top-brief';

const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Asks Claude to pick the event's top recommendations and commitments from
 * across all its sessions. Returns the reason instead of throwing when Claude is not set
 * up or cannot answer, for the console to show.
 */
@Injectable()
export class ClaudeTopBriefWriter {
  private readonly logger = new Logger(ClaudeTopBriefWriter.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 280_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('ANALYSIS_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  async pick(
    event: string,
    count: number,
    calls: BriefCall[],
  ): Promise<{ answer: TopBriefAnswer | null; reason: string | null }> {
    if (!this.client)
      return { answer: null, reason: 'The AI is not set up on the server.' };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: TOP_BRIEF_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: topBriefPrompt(event, count, calls),
          },
        ],
        output_config: {
          effort: 'medium',
          format: betaZodOutputFormat(TopBriefAnswer),
        },
      });
      if (response.stop_reason === 'refusal')
        return { answer: null, reason: 'The AI declined to write this brief.' };
      if (!response.parsed_output) {
        this.logger.warn(
          `top brief answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return { answer: null, reason: 'The AI brief came back incomplete.' };
      }
      return { answer: response.parsed_output, reason: null };
    } catch (error) {
      this.logger.warn(
        `top brief failed: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : (error as Error).message}`,
      );
      return {
        answer: null,
        reason:
          error instanceof Anthropic.RateLimitError
            ? 'The AI is busy right now. Try again in a minute.'
            : 'The AI could not write the brief just now.',
      };
    }
  }
}
