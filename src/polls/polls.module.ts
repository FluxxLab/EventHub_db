import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PollVote } from './entities/poll-vote.entity';
import { Poll } from './entities/poll.entity';
import { PollsController } from './polls.controller';
import { PollsGateway } from './polls.gateway';
import { PollsService } from './polls.service';
import { TallyModule } from '../common/tally/tally.module';

// RealtimeService comes from the global RealtimeModule, as for trivia.
@Module({
  imports: [TypeOrmModule.forFeature([Poll, PollVote]), TallyModule],
  controllers: [PollsController],
  providers: [PollsService, PollsGateway],
  exports: [PollsService],
})
export class PollsModule {}
