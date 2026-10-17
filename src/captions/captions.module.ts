import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EditionsModule } from '../editions/editions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { BackfillController } from './backfill/backfill.controller';
import { BackfillProcessor } from './backfill/backfill.processor';
import { BackfillService } from './backfill/backfill.service';
import { StorageService } from '../common/storage/storage.service';
import { CaptionsController } from './captions.controller';
import { CaptionsGateway } from './captions.gateway';
import { CaptionsArchiveProcessor } from './captions-archive.processor';
import { CaptionsGapfillProcessor } from './captions-gapfill.processor';
import { CaptionsService } from './captions.service';
import {
  IngestController,
  LivekitWebhookController,
} from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { LivekitService } from './livekit.service';
import { ListenController } from './listen.controller';
import { ListenService } from './listen.service';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { DeepTranscriptionProvider } from './transcription/deepgram.provider';
import { FakeTranscriptionProvider } from './transcription/fake.provider';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription.interface';
import { ClaudeTranslationProvider } from './translation/claude.provider';
import { NoopTranslationProvider } from './translation/noop.provider';
import { TRANSLATION_PROVIDER } from './translation/translation.interface';
import { SpeakerName } from './speaker-names/speaker-name.entity';
import { ClaudeSpeakerNamer } from './speaker-names/speaker-namer';
import { SpeakerIntroProcessor } from './speaker-names/speaker-intro.processor';
import { SpeakerNamesController } from './speaker-names/speaker-names.controller';
import { SpeakerNamesService } from './speaker-names/speaker-names.service';
import { SpeakerReviewProcessor } from './speaker-names/speaker-review.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([TranscriptSegment, SpeakerName]),
    SessionsModule,
    // venue streams are only issued for rooms the venue has
    EditionsModule,
    // Re-transcription runs for minutes; it cannot sit on the socket handler.
    BullModule.registerQueue({ name: 'captions-archive' }),
    // Translating a language's missing lines costs a dozen Claude calls; it
    // cannot sit on a delegate's catch-up request.
    BullModule.registerQueue({ name: 'caption-gapfill' }),
    // A desk's late recording: minutes of Deepgram, retried if it fails.
    BullModule.registerQueue({ name: 'caption-backfill' }),
    // A line that sounds like an introduction, looked at a few seconds later.
    BullModule.registerQueue({ name: 'speaker-intro' }),
    // A whole session read for who spoke when; minutes, off the request.
    BullModule.registerQueue({ name: 'speaker-review' }),
  ],
  controllers: [
    // before CaptionsController, whose :sessionId routes are looser
    BackfillController,
    SpeakerNamesController,
    CaptionsController,
    IngestController,
    LivekitWebhookController,
    // POST /sessions/:id/listen: the app's room audio
    ListenController,
  ],
  providers: [
    CaptionsService,
    CaptionsGateway,
    CaptionsArchiveProcessor,
    CaptionsGapfillProcessor,
    BackfillService,
    BackfillProcessor,
    SpeakerNamesService,
    SpeakerIntroProcessor,
    SpeakerReviewProcessor,
    ClaudeSpeakerNamer,
    // presigned uploads of desk recordings, as editions does
    StorageService,
    LivekitService,
    ListenService,
    IngestService,
    {
      provide: TRANSCRIPTION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('DEEPGRAM_API_KEY')
          ? new DeepTranscriptionProvider(config)
          : new FakeTranscriptionProvider(),
    },
    {
      provide: TRANSLATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('ANTHROPIC_API_KEY')
          ? new ClaudeTranslationProvider(config)
          : new NoopTranslationProvider(),
    },
  ],
  exports: [CaptionsService, LivekitService, SpeakerNamesService],
})
export class CaptionsModule {}
