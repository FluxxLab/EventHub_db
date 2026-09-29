import { CatalogModule } from '../catalog/catalog.module';
import { Module } from '@nestjs/common';
import { VotingGateway } from './voting.gateway';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VotingService } from './voting.service';
import { PitchEntry } from './entities/pitch-entry.entity';
import { PitchVote } from './entities/pitch-vote.entity';
import { PitchTopic } from './entities/pitch-topic.entity';
import { PitchVoteEvent } from './entities/pitch-vote-event.entities';
import { VotingController } from './voting.controller';
import { TallyModule } from '../common/tally/tally.module';

@Module({
  imports: [
    // a pitch's track must be one in the library
    CatalogModule,
    TypeOrmModule.forFeature([
      PitchEntry,
      PitchVote,
      PitchTopic,
      PitchVoteEvent,
    ]),
    TallyModule,
  ],
  controllers: [VotingController],
  providers: [VotingGateway, VotingService],
  exports: [VotingService],
})
export class VotingModule {}
