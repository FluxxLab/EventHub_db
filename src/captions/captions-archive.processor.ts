import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { unlink } from 'node:fs/promises';
import { Repository } from 'typeorm';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription.interface';
import type { TranscriptionProvider } from './transcription/transcription.interface';
import { GLOSSARY } from './translation/glossary';

interface ArchiveJob {
  sessionId: string;
  room: string;
  path: string;
}

/**
 * Re-transcribes a finished recording and replaces the session's transcript.
 *
 * The live pass optimises for latency: streaming diarisation is v1, which
 * splits a single speaker into several, and every word is decided before the
 * next one arrives. This pass optimises for accuracy instead - v2 diarisation
 * over the whole recording - and produces the transcript the exports and the
 * digest are built from.
 */
@Processor('captions-archive')
export class CaptionsArchiveProcessor extends WorkerHost {
  private readonly logger = new Logger(CaptionsArchiveProcessor.name);

  constructor(
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly transcription: TranscriptionProvider,
  ) {
    super();
  }

  async process(job: Job<ArchiveJob>): Promise<void> {
    const { sessionId, room, path } = job.data;

    try {
      // A provider without a batch API (the fake one in local dev) simply has
      // no archive method, and the live transcript stands as written.
      if (!this.transcription.archive) return;

      const utterances = await this.transcription.archive(path, {
        // The same domain vocabulary the live stream is primed with - a term
        // Deepgram has never heard is guessed phonetically in both passes.
        keywords: GLOSSARY.map((term) => term.en),
      });

      if (utterances.length === 0) {
        this.logger.warn(`archive produced nothing for ${room} (${sessionId})`);
        return;
      }

      /**
       * Replace rather than append. The live rows are a draft of the same
       * speech, so keeping both would double every sentence in the export and
       * leave the digest reading it twice.
       */
      await this.segments.manager.transaction(async (manager) => {
        await manager.delete(TranscriptSegment, { sessionId });
        await manager.insert(
          TranscriptSegment,
          utterances.map((u) => ({
            sessionId,
            room,
            text: u.text,
            speaker: u.speaker ?? null,
            offsetMs: u.offsetMs,
          })),
        );
      });

      this.logger.log(
        `archived ${utterances.length} utterance(s) for ${room} (${sessionId})`,
      );
    } catch (error) {
      // The live transcript is still there. A failed archive is a downgrade,
      // not a data loss, so it must never fail the job into a retry storm
      // against a file that is about to be deleted.
      this.logger.error(
        `archive failed for ${room} (${sessionId}): ${(error as Error).message}`,
      );
    } finally {
      await unlink(path).catch(() => {});
    }
  }
}
