import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CaptionsModule } from '../captions/captions.module';
import { EditionsModule } from '../editions/editions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ANALYSIS_PROVIDER } from './analysis/analysis.provider';
import { ClaudeAnalysisProvider } from './analysis/claude.provider';
import { StorageService } from '../common/storage/storage.service';
import { ClaudeDeckDesigner } from './deck/deck-designer';
import { ClaudeRapporteurWriter } from './report/rapporteur-writer';
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
    // the deck's design, and the event's logo and cover it is drawn with
    ClaudeDeckDesigner,
    // the session's rapporteur report, filled into the Word template by the console
    ClaudeRapporteurWriter,
    StorageService,
  ],
})
export class CallsToActionModule {}
