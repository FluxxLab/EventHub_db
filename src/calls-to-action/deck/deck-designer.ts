import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DESIGN_INSTRUCTIONS,
  DeckDesignAnswer,
  designPrompt,
  type DeckBrief,
} from './deck-design';

/** An image Claude can look at: the event's logo or cover. */
export type DeckImage = {
  label: 'logo' | 'cover';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
};

const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Asks Claude for a fresh design of an event's call-to-action deck. Returns
 * null, never throws, when Claude is not set up or cannot answer: the console
 * then draws the deck in the event's colours without it.
 */
@Injectable()
export class ClaudeDeckDesigner {
  private readonly logger = new Logger(ClaudeDeckDesigner.name);
  private readonly client: Anthropic | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 })
      : null;
    this.model = config.get<string>('ANALYSIS_MODEL')?.trim() || DEFAULT_MODEL;
  }

  get configured(): boolean {
    return !!this.client;
  }

  async design(
    brief: DeckBrief,
    images: DeckImage[],
  ): Promise<{ answer: DeckDesignAnswer | null; reason: string | null }> {
    if (!this.client)
      return { answer: null, reason: 'The AI is not set up on the server.' };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 12000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: DESIGN_INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: [
              ...images.map((img) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mediaType,
                  data: img.data,
                },
              })),
              {
                type: 'text' as const,
                text: designPrompt(
                  brief,
                  images.map((i) => `the event's ${i.label}`),
                ),
              },
            ],
          },
        ],
        output_config: {
          effort: 'medium',
          format: betaZodOutputFormat(DeckDesignAnswer),
        },
      });
      if (response.stop_reason === 'refusal')
        return { answer: null, reason: 'The AI declined to design this deck.' };
      if (!response.parsed_output) {
        this.logger.warn(
          `deck design answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return { answer: null, reason: 'The AI design came back incomplete.' };
      }
      return { answer: response.parsed_output, reason: null };
    } catch (error) {
      this.logger.warn(
        `deck design failed: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : (error as Error).message}`,
      );
      return {
        answer: null,
        reason:
          error instanceof Anthropic.RateLimitError
            ? 'The AI is busy right now.'
            : 'The AI could not design the deck just now.',
      };
    }
  }
}
