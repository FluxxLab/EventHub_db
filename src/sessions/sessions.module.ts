import { EditionsModule } from '../editions/editions.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SessionAttendance } from './entities/attendance.entity';
import { SessionComment } from '../discussions/entities/session-comment.entity';
import { TranscriptSegment } from '../captions/entities/transcript-segment.entity';
import { StorageService } from '../common/storage/storage.service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SessionRemindersProcessor } from './session-reminders.processor';
import { NotificationsModule } from '../notifications/notifications.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionBookmark } from './entities/bookmark.entity';
import { Session } from './entities/session.entity';
import { Speaker } from './entities/speaker.entity';
import { SessionController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SpeakersController } from './speakers.controller';

@Module({
  imports: [
    EditionsModule,
    // a session's track must be one of its edition's
    CatalogModule,
    TypeOrmModule.forFeature([
      Session,
      Speaker,
      SessionBookmark,
      SessionAttendance,
      // deleting a session has to clear its comments and transcript too -
      // neither table has a foreign key back to sessions
      SessionComment,
      TranscriptSegment,
    ]),
    // a session going live is announced as a push to every delegate
    NotificationsModule,
    // one delayed job per session for the "starts in 15 minutes" reminder,
    // which then fans out as direct notifications to whoever saved it
    BullModule.registerQueue(
      { name: 'session-reminders' },
      { name: 'notifications' },
    ),
  ],
  controllers: [SessionController, SpeakersController],
  providers: [SessionsService, SessionRemindersProcessor, StorageService],
  exports: [SessionsService], // search, captions, discussions will need it
})
export class SessionsModule {}
