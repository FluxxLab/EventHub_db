import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DelegateModule } from '../delegate/delegate.module';
import { SessionsModule } from '../sessions/sessions.module';
import { QuestionVote } from './entities/question-vote.entity';
import { SessionQuestion } from './entities/session-question.entity';
import { QuestionsController } from './questions.controller';
import { QuestionsGateway } from './questions.gateway';
import { QuestionsService } from './questions.service';
import { TallyModule } from '../common/tally/tally.module';

/**
 * Questions from the floor (post-summit report, XV.1). RealtimeService is
 * injected from the global RealtimeModule rather than re-provided here, so
 * emits go through the one instance bound to the socket server.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SessionQuestion, QuestionVote]),
    SessionsModule,
    DelegateModule,
    TallyModule,
  ],
  controllers: [QuestionsController],
  providers: [QuestionsService, QuestionsGateway],
  exports: [QuestionsService],
})
export class QuestionsModule {}
