import { Module } from '@nestjs/common';
import { DiscussionsGateway } from './discussions.gateway';
import { DiscussionService } from './discussions.service';
import { DiscussionsController } from './discussions.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionComment } from './entities/session-comment.entity';
import { CommentVote } from './entities/comment-vote.entity';
import { DiscussionLock } from './entities/discussion-lock.entity';
import { SessionsModule } from '../sessions/sessions.module';
import { DelegateModule } from '../delegate/delegate.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SessionComment, CommentVote, DiscussionLock]),
    SessionsModule,
    DelegateModule,
  ],
  // RealtimeService comes from the global RealtimeModule. Listing it here
  // made a second instance the gateway never bound, so every discussion push
  // (comments, hides, locks) was dropped with "emit before gateway init".
  providers: [DiscussionsGateway, DiscussionService],
  controllers: [DiscussionsController],
})
export class DiscussionsModule {}
