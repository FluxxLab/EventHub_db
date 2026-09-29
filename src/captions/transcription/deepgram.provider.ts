import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramClient } from '@deepgram/sdk';
import { createReadStream } from 'node:fs';
import type {
  ArchiveUtterance,
  RawAudioFormat,
  TranscriptEvent,
  TranscriptionProvider,
  TranscriptionStream,
} from './transcription.interface';
import { ResilientStream, type CloseInfo } from './resilient-stream';

interface DiarisedWord {
  word?: string;
  punctuated_word?: string;
  speaker?: number;
}

interface SpeakerRun {
  text: string;
  speaker?: number;
}

/**
 * Deepgram labels each *word* with a speaker, and a single final regularly
 * spans a handover - a question and its answer arrive together.
 *
 * Attributing the whole final to whoever said most of it erases anyone who
 * only interjects, which is indistinguishable from diarisation failing: one
 * voice appears to hold the floor for the entire session. Splitting at each
 * speaker change keeps both, at the cost of shorter segments.
 */
function speakerRuns(
  words: DiarisedWord[] | undefined,
  fallbackText: string,
): SpeakerRun[] {
  if (!words?.length) return [{ text: fallbackText }];

  const runs: SpeakerRun[] = [];
  for (const word of words) {
    // punctuated_word carries smart_format's punctuation and casing.
    const token = word.punctuated_word ?? word.word;
    if (!token) continue;

    const current = runs[runs.length - 1];
    if (current && current.speaker === word.speaker) {
      current.text += ` ${token}`;
    } else {
      runs.push({ text: token, speaker: word.speaker });
    }
  }

  return runs.length > 0 ? runs : [{ text: fallbackText }];
}

/** Whoever said most of a fragment. Interims are revised constantly, so they
 *  get one speaker rather than being split into flickering runs. */
function dominantSpeaker(
  words: DiarisedWord[] | undefined,
): number | undefined {
  if (!words?.length) return undefined;

  const counts = new Map<number, number>();
  for (const word of words) {
    if (word.speaker === undefined) continue;
    counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  }

  let dominant: number | undefined;
  let best = 0;
  for (const [speaker, count] of counts) {
    if (count > best) {
      dominant = speaker;
      best = count;
    }
  }
  return dominant;
}

@Injectable()
export class DeepTranscriptionProvider implements TranscriptionProvider {
  private readonly logger = new Logger(DeepTranscriptionProvider.name);
  private readonly client: DeepgramClient;
  constructor(config: ConfigService) {
    this.client = new DeepgramClient({
      apiKey: config.getOrThrow<string>('DEEPGRAM_API_KEY'),
    });
  }

  /**
   * The archive pass. diarize_model v2 is batch-only - streaming rejects it -
   * and it is the reason this exists: v2 reads the whole recording before
   * deciding who spoke, instead of guessing incrementally as the audio
   * arrives. utterances gives speaker-segmented turns directly, so there is
   * no word-run stitching to do here.
   */
  async archive(
    filePath: string,
    opts: { keywords: string[] },
  ): Promise<ArchiveUtterance[]> {
    const response = await this.client.listen.v1.media.transcribeFile(
      createReadStream(filePath),
      {
        model: 'nova-3',
        language: 'en',
        smart_format: true,
        // Masked at the source here too, so the archive pass cannot restore
        // words the live captions had already removed.
        profanity_filter: true,
        diarize_model: 'v2',
        utterances: true,
        keyterm: opts.keywords,
      },
    );

    const utterances =
      'results' in response ? (response.results.utterances ?? []) : [];

    return utterances
      .filter((u) => u.transcript && u.transcript.trim().length > 0)
      .map((u) => ({
        text: u.transcript as string,
        speaker: u.speaker,
        offsetMs: Math.round((u.start ?? 0) * 1000),
      }));
  }

  async openStream(
    opts: {
      room: string;
      keywords: string[];
      diarise?: boolean;
      onReopen?: () => void;
      audio?: RawAudioFormat;
    },
    onTranscript: (event: TranscriptEvent) => void,
  ): Promise<TranscriptionStream> {
    /**
     * Deepgram's socket does not stay open for a whole summit day. It closes
     * on its own idle timeout, on a network blip between us and them, and on
     * their side during a deploy - the caption desk reported exactly that on
     * 9 September 2026.
     *
     * ResilientStream reopens it: exponential backoff from 500ms capped at
     * 30s, retried for as long as the room is captured (a failed reopen used
     * to be logged once and then never tried again, leaving the room silent
     * until an operator restarted capture). Audio that arrives while it is
     * reconnecting is dropped rather than written into the dead socket - see
     * ResilientStream.send for why it is not buffered.
     */
    const stream = new ResilientStream({
      room: opts.room,
      onReopen: opts.onReopen,
      log: {
        log: (m) => this.logger.log(`Deepgram ${m}`),
        warn: (m) => this.logger.warn(`Deepgram ${m}`),
        error: (m) => this.logger.error(`Deepgram ${m}`),
      },
      connect: async (onClose) => {
        const conn = await this.connect(opts, onTranscript, onClose);
        return {
          send: (chunk) => conn.sendMedia(chunk),
          keepAlive: () => conn.sendKeepAlive({ type: 'KeepAlive' }),
          close: () => conn.close(),
        };
      },
    });

    await stream.start();

    /**
     * Deepgram closes a stream that has gone quiet for about ten seconds. A
     * capture desk between sessions, or one whose browser tab has been
     * throttled, sends nothing for far longer than that, so the connection
     * would be torn down mid-break and the next speaker would go uncaptioned.
     */
    const keepAlive = setInterval(() => stream.keepAlive(), 5000);

    return {
      sendAudio: (chunk) => {
        stream.send(chunk);
      },
      // close() is synchronous on the socket; the signature stays a promise
      // because the interface every provider implements returns one
      close: () => {
        clearInterval(keepAlive);
        stream.close();
        return Promise.resolve();
      },
    };
  }

  /** One Deepgram connection, wired up. `onClose` fires on every close. */
  private async connect(
    opts: {
      room: string;
      keywords: string[];
      diarise?: boolean;
      audio?: RawAudioFormat;
    },
    onTranscript: (event: TranscriptEvent) => void,
    onClose: (info: CloseInfo) => void,
  ) {
    const conn = await this.client.listen.v1.connect({
      model: 'nova-3',
      // Raw PCM has no container for Deepgram to detect; without these it
      // cannot decode a byte of it. A desk's WebM is left to detection.
      ...(opts.audio
        ? {
            encoding: opts.audio.encoding,
            sample_rate: String(opts.audio.sampleRate),
            channels: String(opts.audio.channels),
          }
        : {}),
      language: 'en',
      smart_format: 'true',
      interim_results: 'true',
      // Deepgram masks what it recognises before the text reaches us, so the
      // stored transcript is masked as well and the real words are not
      // recoverable afterwards. A second pass in profanity.ts covers what this
      // list does not know, Nigerian slang in particular.
      profanity_filter: 'true',
      keyterm: opts.keywords,
      // v1 is the only diarisation model streaming accepts; v2 is batch-only
      // and returns a validation error here. Omitted entirely for a
      // single-voice room rather than set false, so no speaker field comes
      // back at all and the UI renders unlabelled lines.
      ...(opts.diarise === false ? {} : { diarize_model: 'v1' }),
      /**
       * Deepgram's default endpointing is 10ms, which finalises on the
       * shortest pause and produces fragments that end mid-phrase. That hurts
       * diarisation more than anything else available here: the fewer words in
       * a final, the less evidence the diariser has to attribute them, so
       * short turns get swept into whoever was speaking before.
       *
       * 400ms waits for a real breath instead of a syllable gap. Captions
       * appear a fraction later; turns are whole and attribution is steadier.
       */
      endpointing: '400',
      utterance_end_ms: '1200',
      vad_events: 'true',
    });

    /**
     * Highest speaker index this stream has ever produced. Logged when it
     * grows, so "everyone reads as one speaker" can be told apart from a
     * problem downstream: if this never reaches 2, Deepgram genuinely is not
     * separating the voices and the microphone is the thing to fix.
     */
    let voicesHeard = 0;

    conn.on('message', (message) => {
      if (message.type !== 'Results') return; //union also carries Metadata/UtteranceEnd/SpeechStarted
      const alternative = message.channel?.alternatives?.[0];
      const text = alternative?.transcript;
      if (!text) return;

      const words = alternative?.words as DiarisedWord[] | undefined;

      if (message.is_final !== true) {
        onTranscript({ text, isFinal: false, speaker: dominantSpeaker(words) });
        return;
      }

      for (const run of speakerRuns(words, text)) {
        if (run.speaker !== undefined && run.speaker + 1 > voicesHeard) {
          voicesHeard = run.speaker + 1;
          this.logger.log(
            `Deepgram separating ${voicesHeard} voice(s) (${opts.room})`,
          );
        }
        onTranscript({ text: run.text, isFinal: true, speaker: run.speaker });
      }
    });
    conn.on('error', (e) =>
      this.logger.error(`Deepgram error (${opts.room}): ${e.message}`),
    );
    conn.on('close', (event) => {
      /**
       * The code is the whole diagnosis. 1000 is a clean close, 1011 with
       * NET-0001 means Deepgram received no decodable audio for ten seconds
       * (a container without its header looks exactly like silence), and
       * anything in the 4xxx range is an account or parameter problem.
       */
      const info = { code: event?.code, reason: event?.reason };
      this.logger.warn(
        `Deepgram stream closed (${opts.room}): code=${info.code ?? 'none'} reason=${info.reason || 'none'}`,
      );
      onClose(info);
    });

    conn.connect(); //registers handler and open the socket...
    await conn.waitForOpen(); // ..and this resolves once its actually open
    return conn;
  }
}
