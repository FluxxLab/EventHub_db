import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CaptionsService } from './captions.service';

interface GapFillJob {
  sessionId: string;
  language: string;
}

/**
 * Translates the lines a language is missing, off the request path.
 *
 * This used to run inside GET /captions/:id/captions. A delegate opening the
 * captions screen therefore waited on up to a dozen Claude round-trips before
 * seeing any history at all - and because the mobile app prefetched every
 * language at once, one screen open asked for five of those jobs in parallel.
 * They timed out, the failures persisted nothing, and the next reader queued
 * the identical work again.
 *
 * Here the request returns whatever is already translated, immediately, and
 * the fill catches up behind it: each line it saves goes out on that
 * language's caption room, so an open screen fills in rather than staying
 * blank until someone reopens it.
 */
@Processor('caption-gapfill')
export class CaptionsGapfillProcessor extends WorkerHost {
  private readonly logger = new Logger(CaptionsGapfillProcessor.name);

  constructor(private readonly captions: CaptionsService) {
    super();
  }

  async process(job: Job<GapFillJob>): Promise<void> {
    const { sessionId, language } = job.data;
    try {
      const filled = await this.captions.fillTranslationGaps(
        sessionId,
        language,
      );
      if (filled.length > 0) {
        this.logger.log(
          `filled ${filled.length} ${language} caption(s) for ${sessionId}`,
        );
      }
    } catch (error) {
      // Nothing retries this: another delegate opening the screen queues it
      // again, and a translator that is down would only fail the retry too.
      this.logger.warn(
        `gap-fill job failed for ${sessionId} (${language}): ${(error as Error).message}`,
      );
    }
  }
}
