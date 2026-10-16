import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_INSTRUCTIONS,
  RapporteurReportAnswer,
  reportPrompt,
  type ReportBrief,
} from './rapporteur-report';

const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Asks Claude to write a session's rapporteur report from its transcript.
 * Returns the reason instead of throwing when Claude is not set up or cannot
 * answer, for the console to show.
 */
@Injectable()
export class ClaudeRapporteurWriter {
  private readonly logger = new Logger(ClaudeRapporteurWriter.name);
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

  async write(
    brief: ReportBrief,
    transcript: string,
  ): Promise<{ report: RapporteurReportAnswer | null; reason: string | null }> {
    if (!this.client)
      return { report: null, reason: 'The AI is not set up on the server.' };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: REPORT_INSTRUCTIONS,
        messages: [{ role: 'user', content: reportPrompt(brief, transcript) }],
        output_config: {
          effort: 'medium',
          format: betaZodOutputFormat(RapporteurReportAnswer),
        },
      });
      if (response.stop_reason === 'refusal')
        return {
          report: null,
          reason: 'The AI declined to write this report.',
        };
      if (!response.parsed_output) {
        this.logger.warn(
          `rapporteur report answered without the expected shape (stop: ${response.stop_reason})`,
        );
        return { report: null, reason: 'The AI report came back incomplete.' };
      }
      return { report: response.parsed_output, reason: null };
    } catch (error) {
      this.logger.warn(
        `rapporteur report failed: ${error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : (error as Error).message}`,
      );
      return {
        report: null,
        reason:
          error instanceof Anthropic.RateLimitError
            ? 'The AI is busy right now. Try again in a minute.'
            : 'The AI could not write the report just now.',
      };
    }
  }
}
