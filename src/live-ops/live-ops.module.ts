import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TranscriptSegment } from '../captions/entities/transcript-segment.entity';
import { SessionsModule } from '../sessions/sessions.module';
import { LiveOpsController } from './live-ops.controller';
import { LiveOpsService } from './live-ops.service';
import { SessionSwitchService } from './switch/session-switch.service';
import { ClaudeSwitchSuggester } from './switch/switch-suggester';
import { SwitchSuggestion } from './switch/switch-suggestion.entity';

@Module({
  imports: [
    SessionsModule,
    // the AI's changeover suggestions, read from saved captions
    TypeOrmModule.forFeature([SwitchSuggestion, TranscriptSegment]),
  ],
  controllers: [LiveOpsController],
  providers: [LiveOpsService, SessionSwitchService, ClaudeSwitchSuggester],
})
export class LiveOpsModule {}
