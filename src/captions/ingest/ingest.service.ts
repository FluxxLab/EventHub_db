import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import {
  IngressInput,
  type IngressInfo,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { EditionRoomsService } from '../../editions/edition-rooms.service';
import { EditionsService } from '../../editions/editions.service';
import { CaptionsService, type CaptureSource } from '../captions.service';
import { audioRoom, LivekitService } from '../livekit.service';
import type { RawAudioFormat } from '../transcription/transcription.interface';
import { positiveSetting } from '../settings';

/** What Deepgram is sent: 16 kHz mono PCM, plenty for speech and a third of 48 kHz. */
export const INGEST_AUDIO: RawAudioFormat = {
  encoding: 'linear16',
  sampleRate: 16_000,
  channels: 1,
};

/** Our ingresses are named `pic-room:<room>`, which is how a webhook or listing maps back to a room. */
const NAME_PREFIX = 'pic-room:';

/** IngressState_Status.ENDPOINT_PUBLISHING (the enum is not re-exported by livekit-server-sdk). */
const PUBLISHING = 2;
const STATE_NAMES = [
  'inactive',
  'buffering',
  'publishing',
  'error',
  'complete',
] as const;
export type IngressStateName = (typeof STATE_NAMES)[number];

export type IngressInputName = 'rtmp' | 'whip';

/** One venue room and its stream, as the console lists them. The stream key is never included. */
export interface IngestRoomView {
  room: string;
  stream: {
    id: string;
    input: IngressInputName;
    url: string;
    state: IngressStateName;
    diarise: boolean;
  } | null;
  /** Who is captioning the room right now, on any replica. */
  captioning: CaptureSource | null;
}

/** Returned once, when a stream is created or its key rotated. */
export interface IngestCredentials {
  room: string;
  input: IngressInputName;
  url: string;
  streamKey: string;
}

/** Our ingresses: the newest per room, and older ones a rotation failed to revoke. */
interface Listed {
  current: Map<string, IngressInfo>;
  stale: IngressInfo[];
}

/** The API listening to one room's venue stream. */
interface Listener {
  room: string;
  /** Joined only once this replica holds the room. */
  lk: Room | null;
  diarise: boolean;
  /** Set while this listener holds the room in CaptionsService. */
  capturing: boolean;
  /** Set while a track is subscribed; the pump reads frames from it. */
  track: RemoteTrack | null;
  retry: NodeJS.Timeout | null;
  stop: NodeJS.Timeout | null;
}

const key = (room: string) => room.trim().toLowerCase();

/**
 * Venue streams: each room's audio sent from the venue mixer to LiveKit
 * Ingress, captioned without anyone at a capture desk. See
 * docs/live-audio-ingest.md.
 *
 * The API joins each publishing room as a hidden participant, reads the
 * stream's audio as 16 kHz PCM and hands it to CaptionsService exactly as a
 * desk's audio is - same lock, same feed health, same archive. A desk can
 * still caption the room when no stream holds it, which is how the console's
 * sound desk works as a backup.
 *
 * Listening starts on LiveKit's `ingress_started` webhook and, because a
 * webhook can be missed or land on a replica that then restarts, on a
 * reconcile pass every RECONCILE_MS. Every replica may listen; only the one
 * holding the room's capture lock streams it to Deepgram.
 */
@Injectable()
export class IngestService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IngestService.name);
  /** Default for INGEST_RECONCILE_MS: how often streams are re-listed from LiveKit. */
  static readonly RECONCILE_MS = 30_000;
  /** Default for INGEST_RETRY_MS: how often a refused listener retries the room (another source holds it). */
  static readonly RETRY_MS = 5_000;
  /** How long the stream list the console polls is reused before LiveKit is asked again. */
  static readonly LIST_CACHE_MS = 5_000;
  /** A stream that drops for less than this picks up where it left off. */
  static readonly GRACE_MS = CaptionsService.CAPTURE_GRACE_MS;

  private readonly listeners = new Map<string, Listener>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly retryMs: number;
  private readonly reconcileMs: number;
  /**
   * The last listing, shared: every open console polls the stream list every
   * 10 s, and each listing is a LiveKit API call. Writes and reconcile always
   * list afresh and refresh this.
   */
  private listed: { at: number; value: Promise<Listed> } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly livekit: LivekitService,
    private readonly captions: CaptionsService,
    private readonly editions: EditionsService,
    private readonly rooms: EditionRoomsService,
  ) {
    this.retryMs = positiveSetting(
      config,
      'INGEST_RETRY_MS',
      IngestService.RETRY_MS,
    );
    this.reconcileMs = positiveSetting(
      config,
      'INGEST_RECONCILE_MS',
      IngestService.RECONCILE_MS,
    );
  }

  /** INGEST_ENABLED=true and LiveKit configured. Off, every route answers 503. */
  get enabled(): boolean {
    return (
      this.config.get<string>('INGEST_ENABLED') === 'true' &&
      this.livekit.isConfigured()
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.reconcile();
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.reconcileMs,
    );
    this.reconcileTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.all([...this.listeners.values()].map((l) => this.close(l)));
  }

  /* ------------------------------------------------------------ console */

  async list(): Promise<IngestRoomView[]> {
    this.assertEnabled();
    const [names, ingresses] = await Promise.all([
      this.venueRooms(),
      this.listOurs({ cached: true }).then((l) => l.current),
    ]);
    return Promise.all(
      names.map(async (room) => {
        const ingress = ingresses.get(key(room));
        return {
          room,
          stream: ingress ? this.view(ingress) : null,
          captioning: await this.captions.liveSource(room),
        };
      }),
    );
  }

  async create(
    roomName: string,
    input: IngressInputName,
    diarise: boolean,
  ): Promise<IngestCredentials> {
    this.assertEnabled();
    const room = await this.canonicalRoom(roomName);
    if ((await this.ours()).has(key(room))) {
      throw new ConflictException(
        `"${room}" already has a stream. Rotate its key to get a new one.`,
      );
    }
    const created = await this.createIngress(room, input, diarise);
    this.listed = null; // the console sees the new stream on its next poll
    return this.credentials(room, created);
  }

  /** A new key; the old one stops working at once (an encoder using it is cut off). */
  async rotate(
    roomName: string,
    input?: IngressInputName,
    diarise?: boolean,
  ): Promise<IngestCredentials> {
    this.assertEnabled();
    const room = await this.canonicalRoom(roomName);
    const existing = (await this.ours()).get(key(room));
    if (!existing) throw new NotFoundException(`"${room}" has no stream.`);
    // New first, old second: a failure never leaves the room with no stream.
    const created = await this.createIngress(
      room,
      input ?? inputName(existing),
      diarise ?? readDiarise(existing),
    );
    await this.livekit
      .ingressClient()
      .deleteIngress(existing.ingressId)
      .catch((error: Error) =>
        // The old key still works until reconcile removes it (within RECONCILE_MS).
        this.logger.error(
          `could not revoke the old stream for ${room}: ${error.message}`,
        ),
      );
    this.listed = null;
    return this.credentials(room, created);
  }

  async remove(roomName: string): Promise<void> {
    this.assertEnabled();
    const room = await this.canonicalRoom(roomName);
    const existing = (await this.ours()).get(key(room));
    if (!existing) throw new NotFoundException(`"${room}" has no stream.`);
    await this.livekit.ingressClient().deleteIngress(existing.ingressId);
    this.listed = null;
    const listener = this.listeners.get(key(room));
    if (listener) await this.close(listener);
  }

  /* ------------------------------------------------------------ webhook */

  /** LiveKit's webhook: verified, then only the two ingress events matter. */
  async webhook(body: string, authorization?: string): Promise<void> {
    if (!this.enabled) return;
    let event: WebhookEvent;
    try {
      event = await this.livekit.webhookReceiver().receive(body, authorization);
    } catch {
      throw new UnauthorizedException('Bad webhook signature');
    }
    const info = event.ingressInfo;
    const room = info ? roomOf(info) : null;
    if (!info || !room) return;
    if (event.event === 'ingress_started') {
      this.listen(room, readDiarise(info));
    } else if (event.event === 'ingress_ended') {
      const listener = this.listeners.get(key(room));
      if (listener) this.scheduleClose(listener);
    }
  }

  /* ---------------------------------------------------------- listening */

  /**
   * Listens to every publishing stream, and lets go of any that stopped. Also
   * repairs a listener whose room was taken from it (the lock lapsed and
   * another replica took over), by closing it so the next pass starts clean.
   */
  async reconcile(): Promise<void> {
    let ingresses: Map<string, IngressInfo>;
    try {
      const listed = await this.listOurs();
      ingresses = listed.current;
      for (const old of listed.stale) {
        this.logger.warn(`revoking a stale stream key (${old.name})`);
        await this.livekit
          .ingressClient()
          .deleteIngress(old.ingressId)
          .catch(() => {});
      }
    } catch (error) {
      this.logger.warn(
        `reconcile: could not list ingresses: ${(error as Error).message}`,
      );
      return;
    }
    for (const info of ingresses.values()) {
      const room = roomOf(info);
      if (room && isPublishing(info)) {
        this.listen(room, readDiarise(info));
      }
    }
    for (const listener of this.listeners.values()) {
      const info = ingresses.get(key(listener.room));
      if (!info || !isPublishing(info)) {
        this.scheduleClose(listener);
      } else if (
        listener.capturing &&
        this.captions.sourceOf(listener.room) !== 'ingest'
      ) {
        this.logger.warn(
          `ingest for ${listener.room} lost the room; reconnecting`,
        );
        await this.close(listener);
        this.listen(listener.room, readDiarise(info));
      }
    }
  }

  /**
   * Caption a room's venue stream: claim the room first, and only then join
   * LiveKit. Every replica is told about every stream (webhook, reconcile),
   * but only the one holding the room's capture lock joins - the others would
   * pay for a listener whose audio they could not use.
   */
  listen(room: string, diarise: boolean): void {
    const existing = this.listeners.get(key(room));
    if (existing) {
      if (existing.stop) {
        clearTimeout(existing.stop);
        existing.stop = null;
      }
      return;
    }
    const listener: Listener = {
      room,
      lk: null,
      diarise,
      capturing: false,
      track: null,
      retry: null,
      stop: null,
    };
    this.listeners.set(key(room), listener);
    void this.claim(listener);
  }

  /**
   * Take the room in CaptionsService, then join. Refused while a desk (or
   * another replica) holds it: whoever holds a room keeps it, so this retries
   * every RETRY_MS - a Redis check, nothing more - and takes over once they
   * stop. Holding the room costs nothing while no session is live: Deepgram
   * only opens for a live session.
   */
  private async claim(listener: Listener): Promise<void> {
    if (listener.capturing) return;
    try {
      const started = await this.captions.startRoom(
        listener.room,
        listener.diarise,
        undefined,
        { source: 'ingest', audio: INGEST_AUDIO },
      );
      if (this.listeners.get(key(listener.room)) !== listener) {
        // closed while the claim was in flight
        if (started.ok) await this.captions.stopRoom(listener.room);
        return;
      }
      if (started.ok) {
        listener.capturing = true;
        this.logger.log(`captioning ${listener.room} from the venue stream`);
        await this.join(listener);
        return;
      }
    } catch (error) {
      this.logger.warn(
        `could not start ${listener.room}: ${(error as Error).message}`,
      );
    }
    if (this.listeners.get(key(listener.room)) !== listener) return;
    listener.retry = setTimeout(() => {
      listener.retry = null;
      void this.claim(listener);
    }, this.retryMs);
    listener.retry.unref?.();
  }

  /** Join the room's LiveKit room as a hidden subscriber and read the venue stream. */
  private async join(listener: Listener): Promise<void> {
    const lk = new Room();
    listener.lk = lk;
    lk.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
        if (
          track.kind !== TrackKind.KIND_AUDIO ||
          !participant.identity.startsWith('ingress:')
        ) {
          return;
        }
        if (listener.stop) {
          clearTimeout(listener.stop);
          listener.stop = null;
        }
        listener.track = track;
        void this.pump(listener, track);
      },
    );
    lk.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track !== listener.track) return;
      listener.track = null;
      this.scheduleClose(listener);
    });
    lk.on(RoomEvent.Disconnected, () => this.scheduleClose(listener));

    try {
      await lk.connect(
        this.livekit.serverUrl(),
        await this.livekit.ingestListenerToken(
          listener.room,
          this.captions.instanceId,
        ),
        { autoSubscribe: true, dynacast: false },
      );
      this.logger.log(`listening to the venue stream for ${listener.room}`);
    } catch (error) {
      this.logger.warn(
        `could not join ${audioRoom(listener.room)}: ${(error as Error).message}`,
      );
      await this.close(listener); // the next reconcile tries again
    }
  }

  /** Frames from the stream to the caption pipeline, while this listener holds the room. */
  private async pump(listener: Listener, track: RemoteTrack): Promise<void> {
    const stream = new AudioStream(track, {
      sampleRate: INGEST_AUDIO.sampleRate,
      numChannels: INGEST_AUDIO.channels,
    });
    try {
      for await (const frame of stream) {
        if (listener.track !== track) break;
        if (!listener.capturing) continue; // waiting for the room; nothing is queued
        const pcm = frame.data;
        this.captions.sendAudio(
          listener.room,
          Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        );
      }
    } catch (error) {
      this.logger.warn(
        `audio from ${listener.room} stopped: ${(error as Error).message}`,
      );
    }
  }

  /** A stream that stopped gets GRACE_MS to come back before the room is let go. */
  private scheduleClose(listener: Listener): void {
    if (listener.stop) return;
    listener.stop = setTimeout(
      () => void this.close(listener),
      IngestService.GRACE_MS,
    );
    listener.stop.unref?.();
  }

  private async close(listener: Listener): Promise<void> {
    if (this.listeners.get(key(listener.room)) === listener) {
      this.listeners.delete(key(listener.room));
    }
    if (listener.retry) clearTimeout(listener.retry);
    if (listener.stop) clearTimeout(listener.stop);
    listener.track = null;
    const wasCapturing = listener.capturing;
    listener.capturing = false;
    await listener.lk?.disconnect().catch(() => {});
    // Only let the room go if it is still ours; a desk may have taken it.
    if (wasCapturing && this.captions.sourceOf(listener.room) === 'ingest') {
      await this.captions
        .stopRoom(listener.room)
        .catch((error: Error) =>
          this.logger.warn(
            `stopping ${listener.room} failed: ${error.message}`,
          ),
        );
      this.logger.log(
        `stopped captioning ${listener.room} from the venue stream`,
      );
    }
  }

  /* ------------------------------------------------------------ helpers */

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Venue streams are not enabled on this server',
      );
    }
  }

  /** Every ingress this API created, by room. */
  private async ours(): Promise<Map<string, IngressInfo>> {
    return (await this.listOurs()).current;
  }

  /**
   * Every ingress this API created: the newest per room, and any older ones
   * a rotation failed to revoke (reconcile removes those).
   */
  private listOurs({ cached = false } = {}): Promise<Listed> {
    const now = Date.now();
    if (
      cached &&
      this.listed &&
      now - this.listed.at < IngestService.LIST_CACHE_MS
    ) {
      return this.listed.value;
    }
    const value = this.fetchOurs();
    const entry = { at: now, value };
    this.listed = entry;
    // A failed listing must not be reused.
    value.catch(() => {
      if (this.listed === entry) this.listed = null;
    });
    return value;
  }

  private async fetchOurs(): Promise<Listed> {
    const all = await this.livekit.ingressClient().listIngress({});
    const current = new Map<string, IngressInfo>();
    const stale: IngressInfo[] = [];
    for (const info of all) {
      const room = roomOf(info);
      if (!room) continue;
      const other = current.get(key(room));
      if (!other) {
        current.set(key(room), info);
      } else if (createdAt(info) > createdAt(other)) {
        stale.push(other);
        current.set(key(room), info);
      } else {
        stale.push(info);
      }
    }
    return { current, stale };
  }

  /** The current edition's rooms: those described on Venue & rooms and those the programme names. */
  private async venueRooms(): Promise<string[]> {
    const edition = await this.editions.current(true);
    if (!edition) return [];
    return (await this.rooms.list(edition.id)).map((r) => r.name);
  }

  /** A room the venue actually has, spelled as the venue spells it. No stream for "TBC". */
  private async canonicalRoom(room: string): Promise<string> {
    const match = (await this.venueRooms()).find((r) => key(r) === key(room));
    if (!match) {
      throw new BadRequestException(
        `"${room}" is not one of the venue's rooms. Add it on Venue & rooms first.`,
      );
    }
    return match;
  }

  private createIngress(
    room: string,
    input: IngressInputName,
    diarise: boolean,
  ): Promise<IngressInfo> {
    return this.livekit
      .ingressClient()
      .createIngress(
        input === 'whip' ? IngressInput.WHIP_INPUT : IngressInput.RTMP_INPUT,
        {
          name: NAME_PREFIX + room,
          roomName: audioRoom(room),
          participantIdentity: `ingress:${key(room)}`,
          participantName: `${room} (venue audio)`,
          participantMetadata: JSON.stringify({
            diarise,
            createdAt: Date.now(),
          }),
          // Required for every input except WHIP, which can forward as-is.
          enableTranscoding: input !== 'whip',
        },
      );
  }

  private credentials(room: string, info: IngressInfo): IngestCredentials {
    return {
      room,
      input: inputName(info),
      url: info.url,
      streamKey: info.streamKey,
    };
  }

  private view(info: IngressInfo): NonNullable<IngestRoomView['stream']> {
    return {
      id: info.ingressId,
      input: inputName(info),
      url: info.url,
      state: STATE_NAMES[info.state?.status ?? 0] ?? 'inactive',
      diarise: readDiarise(info),
    };
  }
}

function roomOf(info: IngressInfo): string | null {
  return info.name?.startsWith(NAME_PREFIX)
    ? info.name.slice(NAME_PREFIX.length)
    : null;
}

function inputName(info: IngressInfo): IngressInputName {
  return info.inputType === IngressInput.WHIP_INPUT ? 'whip' : 'rtmp';
}

/** When our API created the ingress (0 for one made before this was recorded). */
function createdAt(info: IngressInfo): number {
  try {
    const meta = JSON.parse(info.participantMetadata || '{}') as {
      createdAt?: unknown;
    };
    return typeof meta.createdAt === 'number' ? meta.createdAt : 0;
  } catch {
    return 0;
  }
}

/** Speaker labels are on unless the stream was created without them. */
function readDiarise(info: IngressInfo): boolean {
  try {
    const meta = JSON.parse(info.participantMetadata || '{}') as {
      diarise?: unknown;
    };
    return meta.diarise !== false;
  } catch {
    return true;
  }
}

function isPublishing(info: IngressInfo): boolean {
  return Number(info.state?.status) === PUBLISHING;
}
