import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { BackfillService } from './backfill.service';
import type { BackfillJob, BackfillResult } from './backfill.service';

/**
 * Runs a desk's back-fill (see BackfillService). Unlike the archive pass this
 * one is retried: the recording is the only copy of what the live captions
 * missed, so a Deepgram hiccup should not lose it. The upload is deleted once
 * the job is done, or once it has failed for good.
 */
@Processor('caption-backfill')
export class BackfillProcessor extends WorkerHost {
  private readonly logger = new Logger(BackfillProcessor.name);

  constructor(private readonly backfill: BackfillService) {
    super();
  }

  async process(job: Job<BackfillJob>): Promise<BackfillResult> {
    try {
      const result = await this.backfill.run(job.data);
      await this.backfill.discard(job.data.key);
      return result;
    } catch (error) {
      const final =
        error instanceof UnrecoverableError ||
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.logger.error(
        `back-fill ${job.data.key} failed${final ? '' : ', will retry'}: ${(error as Error).message}`,
      );
      if (final) await this.backfill.discard(job.data.key);
      throw error;
    }
  }
}
