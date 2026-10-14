import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CaptionsModule } from '../captions/captions.module';
import { EditionsModule } from '../editions/editions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ANALYSIS_PROVIDER } from './analysis/analysis.provider';
import { ClaudeAnalysisProvider } from './analysis/claude.provider';
import { CallsToActionController } from './calls-to-action.controller';
import { CallsToActionService } from './calls-to-action.service';
import { CallToAction } from './entities/call-to-action.entity';
import { SessionAnalysis } from './entities/session-analysis.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CallToAction, SessionAnalysis]),
    // the named transcript a session is analysed from
    CaptionsModule,
    SessionsModule,
    EditionsModule,
  ],
  controllers: [CallsToActionController],
  providers: [
    CallsToActionService,
    { provide: ANALYSIS_PROVIDER, useClass: ClaudeAnalysisProvider },
  ],
})
export class CallsToActionModule {}
