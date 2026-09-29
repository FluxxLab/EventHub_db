import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionAttendance } from '../sessions/entities/attendance.entity';
import { SessionBookmark } from '../sessions/entities/bookmark.entity';
import { Session } from '../sessions/entities/session.entity';
import { SessionsModule } from '../sessions/sessions.module';
import { SessionFeedback } from './entities/session-feedback.entity';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

/**
 * Session feedback (post-summit report, XV.2). Bookmarks and attendance are
 * read here to pick who gets the "how was it?" prompt; the 'direct'
 * notification job is queued the same way session reminders are.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SessionFeedback,
      SessionBookmark,
      SessionAttendance,
      Session,
    ]),
    SessionsModule,
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [FeedbackController],
  providers: [FeedbackService],
  // the lead's session status-change hook calls promptForSession
  exports: [FeedbackService],
})
export class FeedbackModule {}
