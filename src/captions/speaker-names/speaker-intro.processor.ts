import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SpeakerNamesService } from './speaker-names.service';
import type { IntroJob } from './speaker-names.service';

/**
 * Asks who a caption line introduced, a few seconds after it was said so the
 * lines that follow it exist (see SpeakerNamesService.runIntro). Not retried:
 * a missed introduction is a name an operator can still type.
 */
@Processor('speaker-intro')
export class SpeakerIntroProcessor extends WorkerHost {
  private readonly logger = new Logger(SpeakerIntroProcessor.name);

  constructor(private readonly names: SpeakerNamesService) {
    super();
  }

  async process(job: Job<IntroJob>): Promise<void> {
    try {
      await this.names.runIntro(job.data);
    } catch (error) {
      this.logger.warn(
        `introduction ${job.data.segmentId} not checked: ${(error as Error).message}`,
      );
    }
  }
}
