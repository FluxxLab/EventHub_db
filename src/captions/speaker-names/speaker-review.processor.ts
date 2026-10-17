import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SpeakerNamesService } from './speaker-names.service';
import type { ReviewJob, ReviewResult } from './speaker-names.service';

/** Runs a whole-session speaker review (see SpeakerNamesService.runReview). */
@Processor('speaker-review')
export class SpeakerReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(SpeakerReviewProcessor.name);

  constructor(private readonly names: SpeakerNamesService) {
    super();
  }

  async process(job: Job<ReviewJob>): Promise<ReviewResult> {
    try {
      return await this.names.runReview(job.data);
    } catch (error) {
      this.logger.error(
        `speaker review of ${job.data.sessionId} failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
