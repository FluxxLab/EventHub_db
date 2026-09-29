import { Injectable, Logger } from '@nestjs/common';
import type {
  TranslationProvider,
  Translations,
} from './translation.interface';

/**
 * Stands in when ANTHROPIC_API_KEY is unset, mirroring the fake transcription
 * provider: captions stay English-only and nothing else changes behaviour.
 */
@Injectable()
export class NoopTranslationProvider implements TranslationProvider {
  private readonly logger = new Logger(NoopTranslationProvider.name);
  private warned = false;

  translate(): Promise<Translations> {
    if (!this.warned) {
      this.logger.warn('ANTHROPIC_API_KEY unset - captions stay English only');
      this.warned = true;
    }
    return Promise.resolve({});
  }
}
