import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TranscriptSegment } from './entities/transcript-segment.entity';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription.interface';
import type {
  RawAudioFormat,
  TranscriptEvent,
  TranscriptionProvider,
  TranscriptionStream,
} from './transcription/transcription.interface';
import { finaliseWav, wavHeader } from './wav';
import { positiveSetting } from './settings';
import { REDIS } from '../common/redis/redis.module';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { statfs, unlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CaptionLanguage, TRANSLATION_TARGETS } from './translation/languages';
import { maskProfanity } from './profanity';
import { dropVerdicts } from './translation/verdict-filter';
import { TRANSLATION_PROVIDER } from './translation/translation.interface';
import type {
  TranslationProvider,
  Translations,
} from './translation/translation.interface';
import {
  CaptureLock,
  delay,
  InterimThrottle,
  KeyedSerializer,
  SeqClock,
  TranslationScheduler,
  type LockResult,
} from './caption-pipeline';

/**
 * extends from the agenda
 */
const SUMMIT_KEYWORDS = ['Pitchathon', 'GBV', 'GS-26'];

/**
 * Where capture:restart goes. Only capture desks join it (on capture:start),
 * so a Deepgram reopen no longer broadcasts to every delegate's phone.
 */
export const CAPTURE_DESKS_ROOM = 'capture-desks';

/**
 * Where a room's audio comes from: a capture desk's browser (WebM/Opus over
 * the socket) or the venue stream (raw PCM, see ingest/). One room has one
 * source at a time - the two formats cannot share a Deepgram stream.
 */
export type CaptureSource = 'desk' | 'ingest';

export interface StartRoomOptions {
  source?: CaptureSource;
  /** Raw audio format; required for 'ingest', never set for a desk. */
  audio?: RawAudioFormat;
}

/** A room a source holds, and what is being transcribed in it. */
interface HeldRoom {
  source: CaptureSource;
  diarise: boolean;
  /** Raw format for the venue stream; undefined for a desk's WebM. */
  audio?: RawAudioFormat;
  /** The live session Deepgram is open for, or null while nothing is live. */
  sessionId: string | null;
  /** A desk was asked for a fresh recording; drop audio until its header. */
  awaitingHeader: boolean;
  /**
   * Raw audio from the last prerollMs while nothing is live, so the opening
   * words of a session - said in the moment before syncRoom notices it went
   * live - still reach Deepgram. The window matches that delay (a sync
   * interval and a margin), not more: a longer one would also replay the
   * previous speaker's last words, said after their session ended, as the
   * start of the next. Cleared whenever transcription closes. Raw PCM only: a
   * desk's WebM cannot be cut and replayed like this.
   */
  preroll: { chunk: Buffer; at: number }[];
  prerollBytes: number;
}

/**
 * Keeps at most windowMs of audio, measured both by arrival time and by the
 * bytes that much audio takes (chunks can arrive in bursts after a stall).
 */
function keepPreroll(
  held: HeldRoom,
  format: RawAudioFormat,
  chunk: Buffer,
  windowMs: number,
  now: number,
): void {
  const limit = (format.sampleRate * format.channels * 2 * windowMs) / 1000;
  held.preroll.push({ chunk, at: now });
  held.prerollBytes += chunk.length;
  while (
    held.preroll.length > 0 &&
    (held.preroll[0].at < now - windowMs ||
      held.prerollBytes - held.preroll[0].chunk.length >= limit)
  ) {
    held.prerollBytes -= held.preroll.shift()!.chunk.length;
  }
}

/** A WebM recording starts with the EBML magic; a later chunk never does. */
const isWebmStart = (chunk: Buffer) =>
  chunk.length >= 4 && chunk.readUInt32BE(0) === 0x1a45dfa3;

/** Free bytes on the volume holding a directory, or null where the platform will not say. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Rooms are matched loosely everywhere else (LOWER/TRIM); so is the source. */
const roomKey = (room: string) => room.trim().toLowerCase();

/**
 * "Audio is arriving from this room" for live ops, 30s TTL. Normalised, as
 * room names are everywhere else: a desk that typed "main hall" for a session
 * in "Main Hall" used to show as No feed.
 */
export const captureStatusKey = (room: string) =>
  `capture:room:${roomKey(room)}`;

/** One caption line on the wire. */
export interface CaptionPayload {
  sessionId: string;
  text: string;
  isFinal: boolean;
  aiGenerated: true;
  language: string;
  speaker?: number | null;
  /** When the English was said - also on translations of it. */
  at: string;
  /**
   * Ordering key: epoch ms of when the English was heard, strictly increasing
   * per room, and identical on an English final, its translations and the
   * stored rows (createdAt) - so a client inserts by seq, not arrival order,
   * and can recognise the same line arriving from history and live.
   */
  seq: number;
  backfill?: boolean;
}

/** A Deepgram event stamped the moment it arrived, before any await. */
interface ReceivedEvent {
  event: TranscriptEvent;
  /** Arrival order across the instance; the interim throttle compares these. */
  eventNo: number;
  seq: number;
}

/** A stored row's ordering key; archived rows share a createdAt, so add the offset. */
export function seqOf(
  row: Pick<TranscriptSegment, 'createdAt' | 'offsetMs'>,
): number {
  return row.createdAt.getTime() + (row.offsetMs ?? 0);
}

@Injectable()
export class CaptionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptionsService.name);

  /** How long a room keeps capturing after its last desk socket dropped. */
  static readonly CAPTURE_GRACE_MS = 15_000;
  /** Default for CAPTIONS_SYNC_MS: how often held rooms are checked for a session starting or ending. */
  static readonly SYNC_MS = 2_000;
  /** Default for CAPTIONS_MIN_FREE_DISK_MB: below this much free in tmp, rooms are captioned but not recorded. */
  static readonly MIN_FREE_DISK_MB = 2_000;

  private readonly syncMs: number;
  private readonly minFreeDiskBytes: number;
  /** CAPTIONS_PREROLL_MS; defaults to one sync interval and a second. */
  private readonly prerollMs: number;
  /** Lock and live-ops status are refreshed at most this often while audio flows. */
  static readonly LOCK_REFRESH_MS = 5_000;
  /** Interims per room: at most one per this many ms. Finals are never held. */
  static readonly INTERIM_INTERVAL_MS = 500;
  /** Backoff before the single retry of a failed translation. */
  static readonly TRANSLATE_RETRY_MS = 1_000;
  private static readonly CONTEXT_LINES = 3;

  /**
   * Connection state, not domain state: each Deepgram stream is bound to the
   * instance holding the room's capture lock; caption fan-out still reaches
   * every instance via the Redis adapter.
   */
  private readonly activeRooms = new Map<string, TranscriptionStream>();

  /**
   * Audio that arrived while Deepgram was still connecting. The first
   * MediaRecorder chunk carries the WebM/EBML header; every later chunk is a
   * bare Opus cluster that cannot be decoded without it. Dropping the header
   * because the stream was not open yet makes Deepgram reject the audio and
   * close the socket, so these are queued and flushed in order instead.
   */
  private readonly pendingAudio = new Map<string, Buffer[]>();

  /**
   * The last few English finals per session, passed to the translator as
   * context. Fragments are short and often start mid-thought - more so since
   * finals are split at speaker changes - and without the preceding lines the
   * model has to guess at pronouns and continuations, which is where most
   * fluent-but-wrong output comes from.
   */
  private readonly recentFinals = new Map<string, string[]>();

  /**
   * A copy of the room's audio on disk, kept only until the archive pass has
   * read it. Written alongside the Deepgram stream rather than instead of it:
   * the live captions still have to arrive in real time.
   */
  private readonly recordings = new Map<
    string,
    { path: string; file: WriteStream; wav: boolean }
  >();

  /**
   * Which source holds each running room, by normalised name. The capture
   * lock is idempotent on the replica that holds it, so without this a desk
   * whose socket lands on the same replica as a venue stream would be let in
   * and its WebM would be fed into a stream expecting PCM. Production runs on
   * one host, so that is not a corner case.
   */
  private readonly sources = new Map<string, CaptureSource>();

  /**
   * Rooms a source holds on this replica, transcribing or not. Keyed by the
   * room string as the source sent it, like activeRooms.
   */
  private readonly held = new Map<string, HeldRoom>();
  /**
   * The spelling each held room was first taken under, by normalised name.
   * Every per-room map is keyed by that spelling, so "Main Hall" from one desk
   * and " main hall" from another are one room, not two Deepgram streams
   * captioning every line twice.
   */
  private readonly heldNames = new Map<string, string>();
  /** Rooms whose syncRoom is running, so a slow one is not stacked. */
  private readonly syncing = new Set<string>();
  private syncTimer: NodeJS.Timeout | null = null;

  /**
   * The session each room was last captioning. Read at stop time, because by
   * then an operator has usually already marked the session completed and
   * findLiveInRoom would return nothing.
   */
  private readonly lastSession = new Map<string, string>();
  /** Throttles the dropped-chunk warning: audio arrives four times a second. */
  private readonly lastSendWarn = new Map<string, number>();

  /** Capture desk sockets per room on this instance, for the disconnect grace. */
  private readonly captureSockets = new Map<string, Set<string>>();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastRefresh = new Map<string, number>();

  readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly lock: CaptureLock;
  /** Fragment handling, one at a time per room, in arrival order. */
  private readonly events = new KeyedSerializer();
  private readonly translations: TranslationScheduler;
  private readonly interims: InterimThrottle<CaptionPayload>;
  private readonly seqClock = new SeqClock();
  private eventNo = 0;

  constructor(
    @InjectRepository(TranscriptSegment)
    private readonly segments: Repository<TranscriptSegment>,
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly transcription: TranscriptionProvider,
    @Inject(TRANSLATION_PROVIDER)
    private readonly translation: TranslationProvider,
    @InjectQueue('captions-archive')
    private readonly archiveQueue: Queue,
    @InjectQueue('caption-gapfill')
    private readonly gapfillQueue: Queue,
    private readonly session: SessionsService,
    private readonly realtime: RealtimeService,
    @Inject(REDIS)
    private readonly redis: Redis,
    config?: ConfigService,
  ) {
    this.lock = new CaptureLock(this.redis, this.instanceId);
    this.syncMs = positiveSetting(
      config,
      'CAPTIONS_SYNC_MS',
      CaptionsService.SYNC_MS,
    );
    this.minFreeDiskBytes =
      positiveSetting(
        config,
        'CAPTIONS_MIN_FREE_DISK_MB',
        CaptionsService.MIN_FREE_DISK_MB,
      ) * 1e6;
    this.prerollMs = positiveSetting(
      config,
      'CAPTIONS_PREROLL_MS',
      this.syncMs + 1_000,
    );
    /**
     * TRANSLATION_CONCURRENCY caps model calls in flight on this instance
     * across every room. Four covers ten rooms: a room finishes a sentence
     * every couple of seconds and a call takes one to three.
     */
    const concurrency = Number(
      config?.get<string | number>('TRANSLATION_CONCURRENCY') ?? 4,
    );
    this.translations = new TranslationScheduler(
      Number.isFinite(concurrency) && concurrency >= 1
        ? Math.floor(concurrency)
        : 4,
    );
    this.interims = new InterimThrottle<CaptionPayload>(
      (_room, payload) =>
        this.realtime.emitToRoom(
          Rooms.caption(payload.sessionId),
          'caption',
          payload,
        ),
      CaptionsService.INTERIM_INTERVAL_MS,
    );
  }

  /* ------------------------------------------------------------ capture */

  /**
   * Start (or rejoin) capture for a room.
   *
   * Holding a room and transcribing it are separate. A source (a desk, or the
   * venue stream) holds the room from here until it stops; Deepgram is only
   * open while a session is live in the room (see syncRoom), because Deepgram
   * bills every minute it is sent and a room's audio runs all day - breaks,
   * lunch, and an encoder left on overnight. Each live session gets its own
   * stream and its own recording, so the archive pass attaches to the right
   * session.
   *
   * Guarded by a Redis lock, not an in-process map: with several API
   * instances a desk that reconnects lands wherever the load balancer sends
   * it, and a second instance opening its own Deepgram stream for the room
   * would caption every line twice. Refused while another instance holds the
   * lock; that instance releases it when its desk stops, or
   * CAPTURE_GRACE_MS after its desk disconnected, and a dead instance's lock
   * lapses on its TTL - after which this takes over.
   *
   * Idempotent on the holding instance: a capture page reconnecting to the
   * same instance rejoins the running stream.
   */
  async startRoom(
    room: string,
    diarise = true,
    socketId?: string,
    { source = 'desk', audio }: StartRoomOptions = {},
  ): Promise<LockResult> {
    room = this.canonical(room);
    const running = this.sources.get(roomKey(room));
    if (running && running !== source) {
      // Whoever holds the room keeps it; the other waits for it to stop.
      return {
        ok: false,
        holder: running === 'ingest' ? 'the venue stream' : 'a capture desk',
        retryAfterMs: CaptionsService.CAPTURE_GRACE_MS,
      };
    }

    const locked = await this.lock.acquire(room);
    if (!locked.ok) {
      this.logger.warn(
        `capture for ${room} refused: held by ${locked.holder ?? 'unknown'} for another ${locked.retryAfterMs}ms`,
      );
      return locked;
    }

    this.attachCaptureSocket(room, socketId);
    if (this.held.has(room)) return { ok: true };

    this.heldNames.set(roomKey(room), room);
    this.held.set(room, {
      source,
      diarise,
      audio,
      sessionId: null,
      awaitingHeader: false,
      preroll: [],
      prerollBytes: 0,
    });
    this.sources.set(roomKey(room), source);
    this.lastRefresh.set(room, Date.now());
    await this.markCapturing(room);
    await this.syncRoom(room);
    return { ok: true };
  }

  sendAudio(room: string, chunk: Buffer): void {
    room = this.canonical(room);
    const held = this.held.get(room);
    if (!held) return;

    // The lock's TTL is kept alive by audio actually flowing - a few times a
    // minute rather than on every chunk - whether or not anything is live.
    const now = Date.now();
    if (
      now - (this.lastRefresh.get(room) ?? 0) >=
      CaptionsService.LOCK_REFRESH_MS
    ) {
      this.lastRefresh.set(room, now);
      void this.refreshCapture(room);
    }

    // A desk's audio is WebM: after a stream opens, only a recording's first
    // chunk (it starts with the EBML magic) can be decoded, so everything
    // before it is dropped rather than fed in mid-container.
    if (held.awaitingHeader) {
      if (!isWebmStart(chunk)) return;
      held.awaitingHeader = false;
    }

    const queue = this.pendingAudio.get(room);
    if (queue) {
      queue.push(chunk);
      return;
    }

    // Nothing live: the room is held, but nobody pays to transcribe it.
    const stream = this.activeRooms.get(room);
    if (!stream) {
      if (held.audio) {
        keepPreroll(held, held.audio, chunk, this.prerollMs, Date.now());
      }
      return;
    }

    // Written before the send, so a Deepgram failure cannot cost us the audio.
    this.recordings.get(room)?.file.write(chunk);

    try {
      stream.sendAudio(chunk);
    } catch (error) {
      /**
       * A chunk that missed its socket, nothing more. The provider owns
       * reconnection (and drops audio itself while reconnecting), so the right
       * thing to do with a failed chunk is lose it and carry on - never forget
       * the room, which used to leave it silent until the desk restarted.
       * Logged once every few seconds rather than four times a second.
       */
      if (now - (this.lastSendWarn.get(room) ?? 0) > 5000) {
        this.lastSendWarn.set(room, now);
        this.logger.warn(
          `dropped audio chunk (${room}): ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Open or close a held room's transcription to match what is live in it:
   * open when a session goes live, close (and archive) when it ends, and
   * start over when one session gives way to the next. Runs when a room is
   * taken and every SYNC_MS after, against the database rather than the
   * sessions cache, which another replica's status change does not clear.
   */
  async syncRoom(room: string): Promise<void> {
    room = this.canonical(room);
    if (this.syncing.has(room)) return;
    this.syncing.add(room);
    try {
      const held = this.held.get(room);
      if (!held) return;
      const live = await this.session.findLiveInRoom(room, true);
      if (this.held.get(room) !== held) return; // stopped meanwhile
      const open = this.activeRooms.has(room) || this.pendingAudio.has(room);
      if (open && live?.id === held.sessionId) return;
      if (open) await this.closeTranscription(room);
      if (live) await this.openTranscription(room, live.id);
    } catch (error) {
      this.logger.warn(
        `could not sync captions for ${room}: ${(error as Error).message}`,
      );
    } finally {
      this.syncing.delete(room);
    }
  }

  private async openTranscription(
    room: string,
    sessionId: string,
  ): Promise<void> {
    const held = this.held.get(room);
    if (!held) return;
    held.sessionId = sessionId;
    this.lastSession.set(room, sessionId);
    // The pre-roll goes first, as if it had arrived while Deepgram connected.
    const since = Date.now() - this.prerollMs;
    this.pendingAudio.set(
      room,
      held.preroll.splice(0).flatMap((p) => (p.at >= since ? [p.chunk] : [])),
    );
    held.prerollBytes = 0;
    const isDesk = !held.audio;
    if (isDesk) {
      // The desk's recording is mid-container by now; ask for a new one.
      held.awaitingHeader = true;
      this.realtime.emitToRoom(CAPTURE_DESKS_ROOM, 'capture:restart', {
        room,
      });
    }

    let stream: TranscriptionStream;
    try {
      stream = await this.transcription.openStream(
        {
          room,
          keywords: SUMMIT_KEYWORDS,
          diarise: held.diarise,
          audio: held.audio,
          // Raw PCM decodes from any byte, so only a desk needs restarting.
          onReopen: isDesk
            ? () => {
                this.logger.warn(
                  `transcription reopened (${room}); asking the capture desk for a fresh recording`,
                );
                const current = this.held.get(room);
                if (current) current.awaitingHeader = true;
                this.realtime.emitToRoom(
                  CAPTURE_DESKS_ROOM,
                  'capture:restart',
                  { room },
                );
              }
            : undefined,
        },
        (event) => this.receive(room, event),
      );
    } catch (error) {
      // Retried on the next sync; the room stays held.
      this.pendingAudio.delete(room);
      held.sessionId = null;
      throw error;
    }
    if (this.held.get(room) !== held) {
      await stream.close().catch(() => {});
      return;
    }
    this.activeRooms.set(room, stream);
    await this.startRecording(room, held.audio);
    this.logger.log(`transcribing ${room} for session ${sessionId}`);

    const queued = this.pendingAudio.get(room) ?? [];
    this.pendingAudio.delete(room);
    for (const chunk of queued) this.sendAudio(room, chunk);
  }

  /**
   * Same bytes the live stream gets, kept for the higher-quality pass later.
   * A desk's WebM is a file already; raw PCM needs a WAV header in front.
   * Skipped when the disk is nearly full: live captions matter more than the
   * archive pass, and a full disk would take the database down with it.
   */
  private async startRecording(
    room: string,
    audio: RawAudioFormat | undefined,
  ): Promise<void> {
    const free = await freeBytes(tmpdir());
    if (free !== null && free < this.minFreeDiskBytes) {
      this.logger.error(
        `only ${Math.round(free / 1e6)} MB free in ${tmpdir()}; not recording ${room} for the archive pass`,
      );
      return;
    }
    const path = join(
      tmpdir(),
      'gs26-capture-' + randomUUID() + (audio ? '.wav' : '.webm'),
    );
    const file = createWriteStream(path);
    if (audio) file.write(wavHeader(audio));
    this.recordings.set(room, { path, file, wav: !!audio });
  }

  /** Deepgram closed and the recording handed to the archive pass; the room stays held. */
  private async closeTranscription(room: string): Promise<void> {
    this.pendingAudio.delete(room);
    const stream = this.activeRooms.get(room);
    this.activeRooms.delete(room);
    this.interims.clear(room);
    const held = this.held.get(room);
    if (held) {
      held.sessionId = null;
      held.awaitingHeader = false;
      held.preroll = [];
      held.prerollBytes = 0;
    }
    await stream
      ?.close()
      .catch((error: Error) =>
        this.logger.warn(`close failed (${room}): ${error.message}`),
      );
    if (stream) this.logger.log(`stopped transcribing ${room}`);
    await this.queueArchive(room);
  }

  /**
   * A capture desk's socket went away. The room keeps running for
   * CAPTURE_GRACE_MS so a desk that reconnects (a wifi blip, a page reload)
   * picks the same stream back up; if none has by then, the room is stopped
   * exactly as caption:stop would - Deepgram closed, recording archived, lock
   * released so a desk on another instance can take over.
   */
  captureSocketLeft(room: string, socketId: string): void {
    room = this.canonical(room);
    const sockets = this.captureSockets.get(room);
    sockets?.delete(socketId);
    if (sockets && sockets.size > 0) return;
    if (!this.held.has(room)) return;
    if (this.stopTimers.has(room)) return;

    this.logger.warn(
      `capture desk for ${room} disconnected; stopping in ${CaptionsService.CAPTURE_GRACE_MS}ms unless it reconnects`,
    );
    const timer = setTimeout(() => {
      this.stopTimers.delete(room);
      if ((this.captureSockets.get(room)?.size ?? 0) > 0) return;
      this.stopRoom(room).catch((error: Error) =>
        this.logger.error(
          `stopping abandoned capture ${room} failed: ${error.message}`,
        ),
      );
    }, CaptionsService.CAPTURE_GRACE_MS);
    timer.unref?.();
    this.stopTimers.set(room, timer);
  }

  async stopRoom(room: string): Promise<void> {
    room = this.canonical(room);
    this.detachAllCaptureSockets(room);
    this.held.delete(room);
    this.heldNames.delete(roomKey(room));
    this.lastRefresh.delete(room);
    await this.closeTranscription(room);
    this.sources.delete(roomKey(room));
    await this.lock.release(room).catch(() => {});
    await this.redis
      .del(this.statusKey(room), this.sourceKey(room))
      .catch(() => {});
  }

  /**
   * Lock and live-ops status, refreshed while audio flows. If the lock has
   * gone to another instance (this one stalled past the TTL and a desk
   * started elsewhere), this instance stands down: two streams for one room
   * would caption everything twice. Its partial recording is discarded, not
   * archived - the archive pass replaces the whole session's rows, and the
   * holder's recording is the one that continues.
   */
  private async refreshCapture(room: string): Promise<void> {
    try {
      const held =
        (await this.lock.refresh(room)) || (await this.lock.acquire(room)).ok;
      if (!held) {
        this.logger.error(
          `capture lock for ${room} is held by another instance; standing down here`,
        );
        this.realtime.emitToRoom(CAPTURE_DESKS_ROOM, 'capture:lost', { room });
        await this.abandonRoom(room);
        return;
      }
      await this.markCapturing(room, true);
    } catch (error) {
      // Redis unreachable: keep captioning. The lock's TTL is what protects
      // against a split, and this retries on the next refresh window.
      this.logger.warn(
        `capture refresh failed (${room}): ${(error as Error).message}`,
      );
    }
  }

  private async abandonRoom(room: string): Promise<void> {
    this.sources.delete(roomKey(room));
    this.held.delete(room);
    this.heldNames.delete(roomKey(room));
    this.detachAllCaptureSockets(room);
    this.pendingAudio.delete(room);
    const stream = this.activeRooms.get(room);
    this.activeRooms.delete(room);
    this.lastRefresh.delete(room);
    this.interims.clear(room);
    await stream?.close().catch(() => {});
    const recording = this.recordings.get(room);
    this.recordings.delete(room);
    this.lastSession.delete(room);
    if (recording) {
      await new Promise<void>((resolve) => recording.file.end(resolve));
      await unlink(recording.path).catch(() => {});
    }
  }

  private attachCaptureSocket(room: string, socketId?: string): void {
    const timer = this.stopTimers.get(room);
    if (timer) {
      clearTimeout(timer);
      this.stopTimers.delete(room);
    }
    if (!socketId) return;
    const sockets = this.captureSockets.get(room) ?? new Set<string>();
    sockets.add(socketId);
    this.captureSockets.set(room, sockets);
  }

  private detachAllCaptureSockets(room: string): void {
    const timer = this.stopTimers.get(room);
    if (timer) clearTimeout(timer);
    this.stopTimers.delete(room);
    this.captureSockets.delete(room);
  }

  /**
   * Hand the finished recording to the archive pass.
   *
   * Queued rather than awaited: re-transcribing an hour of audio takes
   * minutes, and caption:stop is a socket handler an operator is waiting on.
   * Nothing here is allowed to throw - the live transcript already exists,
   * and a failed archive must not break stopping a capture.
   */
  private async queueArchive(room: string): Promise<void> {
    const recording = this.recordings.get(room);
    this.recordings.delete(room);
    const sessionId = this.lastSession.get(room);
    this.lastSession.delete(room);

    if (!recording) return;
    await new Promise<void>((resolve) => recording.file.end(resolve));
    if (recording.wav) {
      await finaliseWav(recording.path).catch((error: Error) =>
        this.logger.warn(`could not finish WAV for ${room}: ${error.message}`),
      );
    }

    // No session means nothing was ever live in this room, so the audio has
    // nowhere to attach. Drop the file rather than leaving it in tmp.
    if (!sessionId) {
      await unlink(recording.path).catch(() => {});
      return;
    }

    try {
      await this.archiveQueue.add('retranscribe', {
        sessionId,
        room,
        path: recording.path,
      });
    } catch (error) {
      this.logger.warn(
        `could not queue archive for ${room}: ${(error as Error).message}`,
      );
      await unlink(recording.path).catch(() => {});
    }
  }

  /** Whether the room is being transcribed (a session is live and Deepgram is open). */
  isActive(room: string): boolean {
    return this.activeRooms.has(this.canonical(room));
  }

  /** Whether a source holds the room on this replica, transcribing or not. */
  isHeld(room: string): boolean {
    return this.held.has(this.canonical(room));
  }

  /** Which source is feeding a room on any replica, from live-ops status. */
  async liveSource(room: string): Promise<CaptureSource | null> {
    const value = await this.redis.get(this.sourceKey(room)).catch(() => null);
    return value === 'desk' || value === 'ingest' ? value : null;
  }

  /** Which source holds a room on this replica, if any. */
  sourceOf(room: string): CaptureSource | null {
    return this.sources.get(roomKey(room)) ?? null;
  }

  /**
   * Live-ops status: `capture:room:<room>` says audio is arriving, and
   * `capture:source:<room>` says from where. Both expire together, 30s after
   * the audio stops. `strict` lets a refresh fail loudly (it is retried).
   */
  private async markCapturing(room: string, strict = false): Promise<void> {
    const source = this.sources.get(roomKey(room)) ?? 'desk';
    const write = async () => {
      await this.redis.set(
        this.statusKey(room),
        new Date().toISOString(),
        'EX',
        30,
      );
      await this.redis.set(this.sourceKey(room), source, 'EX', 30);
    };
    if (strict) await write();
    else await write().catch(() => {});
  }

  /* ------------------------------------------------------- live captions */

  /**
   * Deepgram's callback. Stamped here, synchronously, so arrival order and
   * the time the words were heard survive the awaits that follow; then
   * handled strictly in order per room.
   */
  private receive(room: string, event: TranscriptEvent): void {
    const received: ReceivedEvent = {
      event,
      eventNo: ++this.eventNo,
      seq: this.seqClock.next(room),
    };
    void this.events.run(
      room,
      () => this.onTranscript(room, received),
      /**
       * Fire-and-forget by design, so without this a failure here - a
       * missing column, a dropped connection - disappears entirely and
       * captions simply stop being saved with nothing to explain why.
       */
      (error) =>
        this.logger.error(
          `caption handling failed (${room}): ${(error as Error).message}`,
        ),
    );
  }

  private async onTranscript(
    room: string,
    { event, eventNo, seq }: ReceivedEvent,
  ): Promise<void> {
    // Cached for a few seconds in SessionsService: this runs for every
    // fragment, several a second per room.
    const session = await this.session.findLiveInRoom(room);
    if (!session) return; // break time - nothing live in this room, drop the fragment

    const said = new Date(seq);
    const payload: CaptionPayload = {
      sessionId: session.id,
      // Second pass over Deepgram's own filter - see profanity.ts. The row
      // saved below keeps whatever Deepgram returned; only what reaches a
      // screen is masked again here.
      text: maskProfanity(event.text),
      isFinal: event.isFinal,
      aiGenerated: true,
      language: CaptionLanguage.EN,
      speaker: event.speaker,
      at: said.toISOString(),
      seq,
    };

    if (!event.isFinal) {
      this.interims.interim(room, payload, eventNo);
      return;
    }
    this.interims.final(room, payload, eventNo);

    /**
     * Kept: each translation row points back at the English it came from.
     * The id is made here and the insert is not awaited, so the next
     * fragment for this room is not held behind a database round-trip; the
     * translation job waits on `persisted` before it writes rows that
     * reference this one. createdAt is the moment it was heard (seq), which
     * is what history is ordered and de-duplicated by.
     */
    const segmentId = randomUUID();
    const persisted = this.segments
      .insert({
        id: segmentId,
        sessionId: session.id,
        room,
        text: event.text,
        speaker: event.speaker ?? null,
        language: 'en',
        createdAt: said,
      })
      .then(
        () => true,
        (error: Error) => {
          this.logger.error(
            `failed to persist caption ${segmentId} for ${session.id}: ${error.message}`,
          );
          return false;
        },
      );

    this.lastSession.set(room, session.id);
    // Captured before the current line is appended: the model needs what
    // came before, not the fragment it is already being given.
    const context = this.recentFinals.get(session.id) ?? [];
    this.scheduleTranslation({
      sessionId: session.id,
      room,
      text: event.text,
      context,
      speaker: event.speaker,
      seq,
      segmentId,
      persisted,
    });
    this.recentFinals.set(
      session.id,
      [...context, event.text].slice(-CaptionsService.CONTEXT_LINES),
    );
  }

  /**
   * Finals only. Interim results are revised several times a second, so
   * translating them would multiply the bill for text that visibly rewrites
   * itself, and a final lands on a phrase boundary where translation quality
   * is best.
   *
   * Queued per room behind TRANSLATION_CONCURRENCY and never awaited by the
   * caption path: a slow translation must never delay the English caption,
   * which is the one on the screen in the room.
   */
  private scheduleTranslation(line: {
    sessionId: string;
    room: string;
    text: string;
    context: string[];
    speaker: number | undefined;
    seq: number;
    segmentId: string;
    persisted: Promise<boolean>;
  }): void {
    let targets: CaptionLanguage[] = [];
    void this.translations.schedule(line.room, {
      /**
       * Only the languages somebody is reading right now. A language nobody
       * has open is not translated live; a reader who opens it later gets
       * the gap filled from the English rows (fillTranslationGaps).
       */
      prepare: async () => {
        targets = await this.listeningLanguages(line.sessionId);
        return targets.length > 0;
      },
      call: () =>
        this.translateWithRetry(
          line.text,
          line.context,
          targets,
          line.segmentId,
        ),
      finish: async (translations) => {
        if (!translations) return;
        // The English row is the FK target; without it there is nothing to
        // attach a translation to, so the lines are shown but not stored.
        const stored = await line.persisted;
        this.emitTranslations(line, translations, stored);
      },
      onDrop: () =>
        this.logger.warn(
          `translation backlog full (${line.room}); skipped segment ${line.segmentId} - gap-fill covers it for later readers`,
        ),
      onError: (error) =>
        this.logger.warn(
          `translation failed for segment ${line.segmentId}: ${(error as Error).message}`,
        ),
    });
  }

  private emitTranslations(
    line: {
      sessionId: string;
      room: string;
      text: string;
      speaker: number | undefined;
      seq: number;
      segmentId: string;
    },
    translations: Translations,
    store: boolean,
  ): void {
    const at = new Date(line.seq);
    for (const [language, translated] of Object.entries(translations)) {
      if (!translated) continue;

      /**
       * Source and result together, so a wrong translation can be proved
       * rather than argued about. Debug level: too much for normal running,
       * exactly what is needed while translation quality is being judged.
       */
      this.logger.debug(
        `[${language}] "${line.text.slice(0, 70)}" -> "${translated.slice(0, 70)}"`,
      );

      /**
       * Persisted, not just broadcast, so a late joiner or a reconnect can be
       * backfilled in their language. Not awaited: the live line matters more
       * than the row. createdAt is the English line's, so history and live
       * carry the same seq.
       */
      if (store) {
        void this.segments
          .insert({
            sessionId: line.sessionId,
            room: line.room,
            text: translated,
            speaker: line.speaker ?? null,
            language,
            sourceSegmentId: line.segmentId,
            createdAt: at,
          })
          .catch((error) =>
            this.logger.warn(
              `failed to persist ${language} translation of ${line.segmentId}: ${error}`,
            ),
          );
      }

      const payload: CaptionPayload = {
        sessionId: line.sessionId,
        // Translations are generated after Deepgram has finished, so this
        // pass is the only thing that ever looks at them.
        text: maskProfanity(translated),
        isFinal: true,
        aiGenerated: true,
        language,
        // Carried through from the English final: the label is rendered by
        // the client, so it never goes through the translator.
        speaker: line.speaker,
        at: at.toISOString(),
        seq: line.seq,
      };
      this.realtime.emitToRoom(
        Rooms.caption(line.sessionId, language),
        'caption',
        payload,
      );
    }
  }

  /**
   * One retry after a short backoff, then give up on this line: nothing is
   * persisted, so gap-fill can still produce it for a later reader.
   */
  private async translateWithRetry(
    text: string,
    context: string[],
    targets: CaptionLanguage[],
    segmentId: string,
  ): Promise<Translations | null> {
    try {
      return await this.translate(text, context, targets);
    } catch (first) {
      this.logger.warn(
        `translation of segment ${segmentId} failed, retrying: ${(first as Error).message}`,
      );
    }
    await delay(CaptionsService.TRANSLATE_RETRY_MS);
    try {
      return await this.translate(text, context, targets);
    } catch (second) {
      this.logger.error(
        `translation of segment ${segmentId} failed twice; nothing persisted: ${(second as Error).message}`,
      );
      return null;
    }
  }

  private async translate(
    text: string,
    context: string[],
    targets: readonly CaptionLanguage[] = TRANSLATION_TARGETS,
  ): Promise<Translations> {
    if (targets.length === 0) return {};
    /**
     * Context is part of the key: the same fragment translated after different
     * preceding lines is a different translation, and serving a cached one
     * from the wrong context is worse than paying for the call. Repeated
     * stock phrases still hit, which is where most of the saving was anyway.
     *
     * One key per language, since a call asks only for the languages being
     * read: a Hausa translation cached for one room serves another whatever
     * else was asked alongside it.
     */
    const hash = createHash('sha1');
    for (const line of context) hash.update(line).update('|');
    hash.update(text);
    const base = `caption:tr:${hash.digest('hex')}`;
    const keys = targets.map((language) => `${base}:${language}`);

    const result: Translations = {};
    let cached: (string | null)[] = [];
    try {
      cached = await this.redis.mget(...keys);
    } catch {
      // a cache that is down is a miss, not a failed caption
    }
    const missing: CaptionLanguage[] = [];
    targets.forEach((language, i) => {
      const hit = cached[i];
      if (hit) result[language] = hit;
      else missing.push(language);
    });
    if (missing.length === 0) return result;

    const raw = await this.translation.translate(text, context, missing);

    /**
     * Filtered before it is cached, so a verdict cannot be served from Redis
     * for the next 24 hours after slipping through once.
     */
    const { kept, dropped } = dropVerdicts(text, raw);
    if (dropped.length > 0) {
      this.logger.warn(
        `dropped ${dropped.join(', ')} - translator commented on the fragment instead of translating it: "${text.slice(0, 70)}"`,
      );
    }

    const fresh = Object.entries(kept).filter(
      (entry): entry is [CaptionLanguage, string] => Boolean(entry[1]),
    );
    if (fresh.length > 0) {
      // Sessions repeat terminology constantly - titles, names, recurring
      // phrases - so a day of captions hits this often enough to matter.
      try {
        const pipeline = this.redis.pipeline();
        for (const [language, value] of fresh) {
          pipeline.set(`${base}:${language}`, value, 'EX', 60 * 60 * 24);
        }
        await pipeline.exec();
      } catch {
        // uncached is fine; the translation itself succeeded
      }
    }
    return { ...result, ...kept };
  }

  /* ------------------------------------------------------------ listeners */

  /**
   * Who is reading which language, per session, across every instance.
   *
   * A Redis hash rather than asking socket.io: fetchSockets() on the Redis
   * adapter is a request to every instance and a wait for their replies, per
   * caption line. The gateway counts joins, leaves and disconnects instead.
   * An instance that dies leaves its counts high until the key expires, which
   * errs toward translating for nobody - never toward leaving a reader
   * without their language.
   */
  private listenersKey(sessionId: string): string {
    return `captions:listeners:${sessionId}`;
  }

  async addListener(sessionId: string, language: string): Promise<void> {
    if (language === String(CaptionLanguage.EN)) return;
    try {
      await this.redis
        .multi()
        .hincrby(this.listenersKey(sessionId), language, 1)
        .expire(this.listenersKey(sessionId), 60 * 60 * 12)
        .exec();
    } catch (error) {
      this.logger.warn(
        `listener count not recorded (${sessionId}/${language}): ${(error as Error).message}`,
      );
    }
  }

  async removeListener(sessionId: string, language: string): Promise<void> {
    if (language === String(CaptionLanguage.EN)) return;
    try {
      const left = await this.redis.hincrby(
        this.listenersKey(sessionId),
        language,
        -1,
      );
      if (left < 0) {
        await this.redis.hset(this.listenersKey(sessionId), language, 0);
      }
    } catch (error) {
      this.logger.warn(
        `listener count not recorded (${sessionId}/${language}): ${(error as Error).message}`,
      );
    }
  }

  /** Target languages with at least one reader. Redis down means all of them. */
  async listeningLanguages(sessionId: string): Promise<CaptionLanguage[]> {
    try {
      const counts = await this.redis.hgetall(this.listenersKey(sessionId));
      return TRANSLATION_TARGETS.filter(
        (language) => Number(counts[language] ?? 0) > 0,
      );
    } catch {
      return [...TRANSLATION_TARGETS];
    }
  }

  /**
   * The tail of a session's captions, for a delegate joining late.
   *
   * Capped rather than complete: a two-hour plenary is thousands of rows, and
   * a delegate wants the thread of what is being said now, not the whole
   * morning. Returned oldest-first so the client can prepend it to the live
   * feed without re-sorting.
   */
  /**
   * Wipe a session's caption rows. Live-ops escape hatch for the summit: a
   * capture feed pointed at the wrong room, or a stretch of transcript that
   * should not stand, has to be removable in the moment without a database
   * console.
   *
   * Destructive and total. Captions and the stored transcript are the same
   * rows (TranscriptSegment), so this clears the archive and the export for
   * that session too - there is no soft delete to recover from.
   *
   * Every language room is notified, not just the one the admin was watching:
   * a delegate reading Hausa is looking at rows derived from the same audio,
   * and leaving their screen populated would be worse than clearing nothing.
   */
  async clearCaptions(sessionId: string): Promise<{ deleted: number }> {
    const { affected } = await this.segments.delete({ sessionId });

    for (const language of [CaptionLanguage.EN, ...TRANSLATION_TARGETS]) {
      this.realtime.emitToRoom(
        Rooms.caption(sessionId, language),
        'captions:cleared',
        {
          sessionId,
        },
      );
    }

    this.logger.warn(
      `captions cleared for session ${sessionId}: ${affected ?? 0} row(s) deleted`,
    );
    return { deleted: affected ?? 0 };
  }

  async recentCaptions(
    sessionId: string,
    language = 'en',
    limit = 60,
  ): Promise<
    { text: string; speaker: number | null; at: Date; seq: number }[]
  > {
    // Served by idx_transcript_session_language_order (CaptionIndexes).
    const rows = await this.segments.find({
      where: { sessionId, language },
      order: { offsetMs: 'DESC', createdAt: 'DESC' },
      take: limit,
    });

    // A translation this language is missing gets filled in the background,
    // never in this request. Filling it here meant a delegate's catch-up call
    // waited on a dozen Claude round-trips: the calls timed out, nothing was
    // persisted, and the next reader asked for exactly the same work again.
    // The job persists what it translates and pushes each line out on this
    // language's caption room, so the history arrives on the open screen a
    // moment later instead of holding the response hostage.
    if (language !== 'en')
      void this.queueTranslationGapFill(sessionId, language);

    // seq matches what the live `caption` event carried for the same line,
    // so a client can merge history with lines that arrived meanwhile.
    return rows.reverse().map((r) => ({
      text: maskProfanity(r.text),
      speaker: r.speaker,
      at: r.createdAt,
      seq: seqOf(r),
    }));
  }

  /**
   * One job per session and language at a time. The jobId is the dedupe: five
   * delegates opening the same session in Hausa queue one fill between them,
   * not five identical ones racing to translate the same rows.
   */
  private async queueTranslationGapFill(
    sessionId: string,
    language: string,
  ): Promise<void> {
    try {
      await this.gapfillQueue.add(
        'fill',
        { sessionId, language },
        {
          jobId: `gapfill:${sessionId}:${language}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      // Catch-up still returns what exists; a queue that is down must not turn
      // a readable history into a failed request.
      this.logger.warn(
        `could not queue ${language} gap-fill for ${sessionId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Translate the English lines this language is missing, on demand.
   *
   * Translations are produced live, as each final lands. Anything said while
   * the translator was unreachable, or before a session's captions were being
   * translated at all, therefore has an English row and nothing else - and a
   * delegate switching to Hausa mid-session saw a short history or an empty
   * one, with no way to ever recover those lines.
   *
   * So the gap is filled from the English rows the moment someone asks for
   * that language, and persisted, which means it is paid for once no matter
   * how many delegates read it afterwards. The service-level cache in
   * translate() usually absorbs even that.
   *
   * Runs on the caption-gapfill queue, never on the request that triggered it
   * - see recentCaptions. Each line it saves is emitted on that language's
   * caption room, so a delegate already looking at the screen watches the
   * history fill in rather than having to reopen it.
   *
   * Bounded deliberately: only the most recent GAP_FILL_MAX lines, a few at a
   * time. The thread of what is being said now is worth more than a complete
   * morning that costs a hundred translate calls to assemble.
   */
  private static readonly GAP_FILL_MAX = 12;
  private static readonly GAP_FILL_CONCURRENCY = 4;

  async fillTranslationGaps(
    sessionId: string,
    language: string,
  ): Promise<TranscriptSegment[]> {
    const [english, existing] = await Promise.all([
      this.segments.find({
        where: { sessionId, language: 'en' },
        order: { offsetMs: 'DESC', createdAt: 'DESC' },
        take: 60,
      }),
      this.segments.find({
        where: { sessionId, language },
        order: { offsetMs: 'DESC', createdAt: 'DESC' },
        take: 60,
      }),
    ]);
    if (english.length === 0) return [];

    const translated = new Set(
      existing.map((r) => r.sourceSegmentId).filter(Boolean),
    );
    // newest first, so a capped fill covers what they are reading right now
    const missing = english
      .filter((r) => !translated.has(r.id))
      .slice(0, CaptionsService.GAP_FILL_MAX);
    if (missing.length === 0) return [];

    this.logger.log(
      `translating ${missing.length} missing ${language} caption(s) for ${sessionId}`,
    );

    const saved: TranscriptSegment[] = [];
    for (
      let i = 0;
      i < missing.length;
      i += CaptionsService.GAP_FILL_CONCURRENCY
    ) {
      const batch = missing.slice(i, i + CaptionsService.GAP_FILL_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (source) => {
          try {
            // No context: the surrounding lines are not reliably present for
            // an old fragment, and a wrong context is worse than none.
            const translations = await this.translate(
              source.text,
              [],
              [language as CaptionLanguage],
            );
            const text = translations[language as CaptionLanguage];
            if (!text) return null;
            return await this.segments.save(
              this.segments.create({
                sessionId,
                room: source.room,
                text,
                speaker: source.speaker,
                language,
                sourceSegmentId: source.id,
                offsetMs: source.offsetMs,
                // The English line's time, so this row sorts and de-dupes
                // exactly where the English one does.
                createdAt: source.createdAt,
              }),
            );
          } catch (error) {
            this.logger.warn(
              `gap-fill failed for ${source.id}: ${(error as Error).message}`,
            );
            return null;
          }
        }),
      );
      saved.push(...results.filter((r): r is TranscriptSegment => r !== null));
    }

    // Oldest first, so a screen appending them reads in the order it was said.
    saved.sort((a, b) => seqOf(a) - seqOf(b));
    for (const row of saved) {
      this.realtime.emitToRoom(Rooms.caption(sessionId, language), 'caption', {
        sessionId,
        text: maskProfanity(row.text),
        isFinal: true,
        // Backfill, not something just said - the client uses this to append
        // to the history rather than the live thread.
        backfill: true,
        aiGenerated: true,
        language,
        speaker: row.speaker,
        at: row.createdAt.toISOString(),
        seq: seqOf(row),
      } satisfies CaptionPayload);
    }
    return saved;
  }

  /**
   * One session's transcript in one language.
   *
   * The language filter is not optional: since translations are persisted
   * alongside the English rows, an unfiltered query returns every language
   * interleaved, which reads as a corrupted transcript rather than a complete
   * one. Defaults to English so existing admin callers are unchanged.
   */
  fullTranscript(
    sessionId: string,
    language = 'en',
  ): Promise<TranscriptSegment[]> {
    return this.segments.find({
      where: { sessionId, language },
      /**
       * Archived rows carry an offset and are all written in one insert, so
       * createdAt cannot order them. Live rows have a null offset and sort
       * last under Postgres' ASC default, which is right: a session is
       * either archived or it is not, never half of each.
       */
      order: { offsetMs: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * On shutdown (a deploy, a scale-down) the locks are released rather than
   * left to expire, so a desk reconnecting to another instance can take its
   * room back straight away instead of waiting out the TTL.
   */
  /** Checks held rooms for sessions starting and ending (see syncRoom). */
  onModuleInit(): void {
    this.syncTimer = setInterval(() => {
      for (const room of this.held.keys()) void this.syncRoom(room);
    }, this.syncMs);
    this.syncTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const timer of this.stopTimers.values()) clearTimeout(timer);
    this.stopTimers.clear();
    for (const [room, stream] of this.activeRooms) {
      this.interims.clear(room);
      await stream
        .close()
        .catch(() => this.logger.warn(`close failed (${room})`));
    }
    for (const room of this.held.keys()) {
      await this.lock.release(room).catch(() => {});
    }
    this.held.clear();
    this.heldNames.clear();
    this.sources.clear();
  }

  /**
   * "A desk is capturing this room" for the live-ops board, which reads
   * `capture:room:<room>`. This used to be written as `capture: room: <room>`
   * (with spaces), so the board never saw a capture running.
   */
  private statusKey(room: string): string {
    return captureStatusKey(room);
  }

  private sourceKey(room: string): string {
    return `capture:source:${roomKey(room)}`;
  }

  /** A room as this replica holds it, whichever way the caller spelled it. */
  private canonical(room: string): string {
    return this.heldNames.get(roomKey(room)) ?? room;
  }
}
