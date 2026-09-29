import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';
import { CAPTURE_DESKS_ROOM, CaptionsService } from './captions.service';
import { CaptionLanguage, toCaptionLanguage } from './translation/languages';

/**
 * Delegates on older builds send a bare sessionId, which means English.
 */
type CaptionSubscription = string | { sessionId: string; language?: string };

function parseSubscription(body: CaptionSubscription): {
  sessionId: string;
  language: CaptionLanguage;
} {
  if (typeof body === 'string') {
    return { sessionId: body, language: CaptionLanguage.EN };
  }
  return {
    sessionId: body.sessionId,
    language: toCaptionLanguage(body.language),
  };
}

/** Caption rooms a socket has joined, so leaves and disconnects are counted once. */
function captionRooms(socket: Socket): Set<string> {
  const data = socket.data as { captionRooms?: Set<string> };
  data.captionRooms ??= new Set<string>();
  return data.captionRooms;
}

const roomKey = (sessionId: string, language: string) =>
  `${language}|${sessionId}`;

/** A capture:start that was refused because another instance held the room. */
interface PendingCapture {
  room: string;
  diarise: boolean;
  nextTry: number;
}

/** How often a refused desk's audio re-tries the room's lock. */
const CAPTURE_RETRY_MS = 2_000;

@WebSocketGateway({ cors: { origin: '*' } })
export class CaptionsGateway implements OnGatewayDisconnect {
  constructor(private readonly captionsService: CaptionsService) {}

  /**
   * Both sides of the gateway care about a socket going away: a delegate's
   * languages stop counting as read, and a capture desk's room starts its
   * grace period (see CaptionsService.captureSocketLeft).
   */
  handleDisconnect(socket: Socket) {
    socket.data.pendingCapture = undefined;
    const rooms = (socket.data as { captionRooms?: Set<string> }).captionRooms;
    for (const key of rooms ?? []) {
      const at = key.indexOf('|');
      void this.captionsService.removeListener(
        key.slice(at + 1),
        key.slice(0, at),
      );
    }
    rooms?.clear();

    const captureRoom = socket.data.captureRoom as string | undefined;
    if (captureRoom) {
      this.captionsService.captureSocketLeft(captureRoom, socket.id);
    }
  }

  /**
   * delegate side
   */
  @SubscribeMessage('captions:join')
  join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: CaptionSubscription,
  ) {
    const { sessionId, language } = parseSubscription(body);
    void socket.join(Rooms.caption(sessionId, language));
    // Counted so translation can skip languages nobody is reading.
    const joined = captionRooms(socket);
    const key = roomKey(sessionId, language);
    if (!joined.has(key)) {
      joined.add(key);
      void this.captionsService.addListener(sessionId, language);
    }
    return { joined: sessionId, language };
  }

  @SubscribeMessage('captions:leave')
  leave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: CaptionSubscription,
  ) {
    const { sessionId, language } = parseSubscription(body);
    void socket.leave(Rooms.caption(sessionId, language));
    const joined = captionRooms(socket);
    if (joined.delete(roomKey(sessionId, language))) {
      void this.captionsService.removeListener(sessionId, language);
    }
    return { left: sessionId, language };
  }

  /**
   * capture side (admin / capture page)
   *
   * Session admins exist for exactly this: the console shows them the
   * Capture tab and the REST side already issues them a publish token, so
   * the socket has to let them start a room and stream audio too. Checking
   * for the literal 'admin' here was what stopped them.
   */
  private static canCapture(socket: Socket): boolean {
    const role = (socket.data.user as { role?: string } | undefined)?.role;
    return role === AccessTier.ADMIN || role === AccessTier.SESSION_ADMIN;
  }

  @SubscribeMessage('capture:start')
  async startCapture(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: string | { room: string; diarise?: boolean },
  ) {
    if (!CaptionsGateway.canCapture(socket)) return { error: 'forbidden' };

    // Older capture pages send a bare room string, which means diarise.
    const room = typeof body === 'string' ? body : body.room;
    const diarise = typeof body === 'string' ? true : body.diarise !== false;

    // A desk switching rooms on the same socket lets go of the old one.
    const previous = socket.data.captureRoom as string | undefined;
    if (previous && previous !== room) {
      this.captionsService.captureSocketLeft(previous, socket.id);
      socket.data.captureRoom = undefined;
    }

    const started = await this.captionsService.startRoom(
      room,
      diarise,
      socket.id,
    );
    if (!started.ok) {
      /**
       * Another API instance is already capturing this room. Its lock is
       * released when that desk stops, 15s after it disconnects, or when
       * the lock lapses if that instance died.
       *
       * The capture page replays capture:start after a reconnect and does
       * not look at the answer, then keeps streaming - so a desk that
       * reconnected to a different instance is remembered here, and its own
       * audio keeps retrying the lock (see audio()) until the old instance
       * lets go. It then takes over without anyone touching the desk.
       */
      socket.data.pendingCapture = {
        room,
        diarise,
        nextTry: Date.now() + CAPTURE_RETRY_MS,
      } satisfies PendingCapture;
      return {
        error: 'capture-busy',
        message:
          started.holder === 'the venue stream'
            ? `"${room}" is being captioned from the venue stream. This desk stands by and takes over if the stream stops.`
            : `Capture for "${room}" is already running on another server. Stop it there, or retry in ${Math.ceil(started.retryAfterMs / 1000)}s.`,
        retryAfterMs: started.retryAfterMs,
      };
    }
    if (socket.disconnected) {
      // dropped while the stream was opening; nobody will ever stop it
      this.captionsService.captureSocketLeft(room, socket.id);
      return { capturing: room, diarise };
    }
    this.adoptCapture(socket, room);
    return { capturing: room, diarise };
  }

  private adoptCapture(socket: Socket, room: string): void {
    socket.data.pendingCapture = undefined;
    socket.data.captureRoom = room; //subsequent audio from this socket belong to this room
    // capture:restart and capture:lost go to capture desks only.
    void socket.join(CAPTURE_DESKS_ROOM);
  }

  @SubscribeMessage('capture:audio')
  audio(@ConnectedSocket() socket: Socket, @MessageBody() chunk: Buffer) {
    if (!CaptionsGateway.canCapture(socket)) return;
    const room = socket.data.captureRoom as string | undefined;
    if (room) {
      this.captionsService.sendAudio(room, chunk);
      return;
    }

    // Refused earlier because another instance held the room: try again,
    // at most every CAPTURE_RETRY_MS. This chunk itself is dropped - it is
    // mid-container, and the fresh recording asked for below starts clean.
    const pending = socket.data.pendingCapture as PendingCapture | undefined;
    if (!pending || Date.now() < pending.nextTry) return;
    pending.nextTry = Date.now() + CAPTURE_RETRY_MS;
    void this.captionsService
      .startRoom(pending.room, pending.diarise, socket.id)
      .then((started) => {
        if (!started.ok) return;
        if (socket.disconnected || socket.data.pendingCapture !== pending) {
          // gone (or stopped) while the lock was being taken: let the grace
          // period decide, exactly as for any departed desk
          this.captionsService.captureSocketLeft(pending.room, socket.id);
          return;
        }
        this.adoptCapture(socket, pending.room);
        // A new stream needs the WebM header only a new recording carries.
        socket.emit('capture:restart', { room: pending.room });
      })
      .catch(() => {
        // Deepgram refused to open; the next chunk tries again.
      });
  }

  @SubscribeMessage('caption:stop')
  async stopCapture(@ConnectedSocket() socket: Socket) {
    socket.data.pendingCapture = undefined;
    const room = socket.data.captureRoom as string | undefined;
    if (room) {
      await this.captionsService.stopRoom(room);
      socket.data.captureRoom = undefined;
    }

    return { stopped: room ?? null };
  }
}
