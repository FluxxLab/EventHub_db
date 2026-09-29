import { Module } from '@nestjs/common';
import { LiveTallyService } from './live-tally.service';

/** Live vote counts and coalesced broadcasts; REDIS comes from the global RedisModule. */
@Module({
  providers: [LiveTallyService],
  exports: [LiveTallyService],
})
export class TallyModule {}
