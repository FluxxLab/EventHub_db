import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SWITCH_INSTRUCTIONS,
  SwitchAnswer,
  switchPrompt,
  type CaptionLine,
  type RoomPlan,
} from './switch-detector';

const DEFAULT_MODEL = 'claude-fable-5-1';

/**
 * Asks Claude whether a room has changed over. Low effort: the question is
 * narrow and the captions short, and it runs during a live event. Any failure
 * is "no answer", never an error the room notices.
 */
@Injectable()
export class ClaudeSwitchSuggester {
  private readonly logger = new Logger(ClaudeSwitchSuggester.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 })
      : null;
    this.model =
      config.get<string>('SESSION_SWITCH_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  async judge(
    plan: RoomPlan,
    lines: CaptionLine[],
    now: Date,
  ): Promise<SwitchAnswer | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SWITCH_INSTRUCTIONS,
        messages: [{ role: 'user', content: switchPrompt(plan, lines, now) }],
        output_config: {
          effort: 'low',
          format: betaZodOutputFormat(SwitchAnswer),
        },
      });
      if (response.stop_reason === 'refusal') {
        this.logger.warn(`switch check declined for ${plan.room}`);
        return null;
      }
      return response.parsed_output ?? null;
    } catch (error) {
      this.logger.warn(
        `switch check failed for ${plan.room}: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : (error as Error).message}`,
      );
      return null;
    }
  }
}
