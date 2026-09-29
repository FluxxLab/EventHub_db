import { Injectable, Logger } from '@nestjs/common';
import type {
  TranscriptEvent,
  TranscriptionProvider,
  TranscriptionStream,
} from './transcription.interface';

@Injectable()
export class FakeTranscriptionProvider implements TranscriptionProvider {
  private readonly logger = new Logger('FakeTranscription');

  async openStream(
    opts: { room: string; keywords: string[] },
    onTranscript: (event: TranscriptEvent) => void,
  ): Promise<TranscriptionStream> {
    this.logger.log(`Opening fake transcription open (${opts.room})`);
    let n = 0;

    return {
      sendAudio: (chunk: Buffer) => {
        n += 1;
        onTranscript({
          text: `[dev] caption ${n} from ${opts.room} (${chunk.length} bytes)`,
          isFinal: n % 3 === 0,
          // every third event is "final" -> exercise persistence
        });
      },
      close: async () =>
        this.logger.log(`[dev] fake transcription closed (${opts.room})`),
    };
  }
}
