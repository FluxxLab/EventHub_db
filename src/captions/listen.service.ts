import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TrackType } from 'livekit-server-sdk';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { EditionAccessService } from '../common/edition-scope/edition-access.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { Session, SessionStatus } from '../sessions/entities/session.entity';
import { SessionsService } from '../sessions/sessions.service';
import { audioRoom, LivekitService } from './livekit.service';

export type ListenChannel = { id: string; label: string };

/** What `POST /sessions/:id/listen` returns. */
export type ListenGrant = {
  /** LiveKit server the app connects to (so the app needs no URL of its own). */
  url: string;
  /** Subscribe-only room token for this delegate; refresh before `expiresAt`. */
  token: string;
  room: string;
  /** The channel asked for, or the first one on air. */
  channel: string;
  /** Audio tracks on air in the room, each one a channel (floor, interpretation). */
  channels: ListenChannel[];
  expiresAt: string;
};

/** Short, so a delegate who loses their ticket (or a leaked token) drops out within minutes. */
export const LISTEN_TOKEN_TTL_SEC = 10 * 60;
/** Reading the room's channels must never hold up a listener. */
const CHANNEL_LOOKUP_MS = 2_000;
const FLOOR: ListenChannel = { id: 'floor', label: 'Floor' };
/** Track names that can be a channel id (the app sends one back). */
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Room audio for delegates: a short-lived LiveKit token that can only
 * listen. The organiser publishes one audio track per channel into the
 * session's venue room, named by channel id (`floor`, `fr`, `ha`, …); the
 * app plays the one the delegate picks.
 */
@Injectable()
export class ListenService {
  private readonly logger = new Logger(ListenService.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly livekit: LivekitService,
    private readonly dataSource: DataSource,
    private readonly editionAccess: EditionAccessService,
  ) {}

  async grant(
    sessionId: string,
    user: AuthUser,
    channel?: string,
  ): Promise<ListenGrant> {
    if (!this.livekit.isConfigured()) {
      throw new ServiceUnavailableException('Live audio is not configured');
    }
    const session = await this.sessions.findById(sessionId);
    // Who may listen is settled before anything about the session's state,
    // so someone without a ticket learns nothing about whether it is live.
    await this.assertMayListen(session, user);
    if (session.status !== SessionStatus.LIVE) {
      throw new NotFoundException('Session is not live');
    }
    if (!(await this.audioOffered(session.editionId))) {
      throw new NotFoundException('Room audio is not offered for this event');
    }

    const channels = await this.channels(session.room);
    const chosen = channel ?? channels[0].id;
    if (!channels.some((c) => c.id === chosen)) {
      throw new NotFoundException('That channel is not on air');
    }
    const expiresAt = new Date(Date.now() + LISTEN_TOKEN_TTL_SEC * 1000);
    return {
      url: this.livekit.serverUrl(),
      token: await this.livekit.listenerToken(
        session.room,
        user.id,
        LISTEN_TOKEN_TTL_SEC,
      ),
      room: audioRoom(session.room),
      channel: chosen,
      channels,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * The same people who can be at the session: a ticket for its event.
   * Staff always may (admins and session admins everywhere, an event
   * organiser at their own events). A session filed under no event has no
   * ticket to hold, so any signed-in delegate may listen to it.
   */
  private async assertMayListen(session: Session, user: AuthUser) {
    if (
      user.role === AccessTier.ADMIN ||
      user.role === AccessTier.SESSION_ADMIN
    )
      return;
    const editionId = session.editionId;
    if (!editionId) return;
    if (
      user.role === AccessTier.EVENT_ADMIN &&
      (await this.editionAccess.editionsOf(user.id)).includes(editionId)
    )
      return;
    const rows: { holds: boolean }[] = await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM tickets
                      WHERE "editionId" = $1 AND "delegateId" = $2) AS "holds"`,
      [editionId, user.id],
    );
    if (!rows[0]?.holds) {
      throw new ForbiddenException(
        'Room audio is for ticket holders of this event',
      );
    }
  }

  /** Whether the event has the `audio` feature on (edition-less sessions: yes). */
  private async audioOffered(editionId: string | null): Promise<boolean> {
    if (!editionId) return true;
    const rows: { features: string[] | null }[] = await this.dataSource.query(
      `SELECT features FROM editions WHERE id = $1`,
      [editionId],
    );
    const features = rows[0]?.features;
    return !features || features.includes('audio');
  }

  /**
   * The channels on air: every audio track published into the room, by
   * name. With one track or none (a single desk microphone, or the
   * organiser not started yet) it is simply the floor. If LiveKit cannot be
   * asked in time the floor is offered too - the token still works, and the
   * app hears whatever is published.
   */
  async channels(room: string): Promise<ListenChannel[]> {
    let names: string[] = [];
    try {
      const participants = await Promise.race([
        this.livekit.roomServiceClient().listParticipants(audioRoom(room)),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('timed out')),
            CHANNEL_LOOKUP_MS,
          ).unref(),
        ),
      ]);
      names = [
        ...new Set(
          participants.flatMap((p) =>
            p.tracks
              .filter(
                (t) => t.type === TrackType.AUDIO && CHANNEL_ID.test(t.name),
              )
              .map((t) => t.name),
          ),
        ),
      ];
    } catch (error) {
      // A room nobody has joined yet does not exist: that is the floor too.
      this.logger.debug(
        `channels for ${audioRoom(room)}: ${(error as Error).message}`,
      );
    }
    if (names.length <= 1) {
      return [names[0] ? { id: names[0], label: FLOOR.label } : FLOOR];
    }
    // floor first, then the interpretation channels in a stable order
    names.sort((a, b) =>
      a === FLOOR.id ? -1 : b === FLOOR.id ? 1 : a.localeCompare(b),
    );
    return names.map((id) => ({ id, label: ListenService.label(id) }));
  }

  /** `floor` → Floor, a language code → "French interpretation", else the name. */
  static label(id: string): string {
    if (id.toLowerCase() === FLOOR.id) return FLOOR.label;
    if (/^[a-z]{2,3}$/i.test(id)) {
      try {
        const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(
          id.toLowerCase(),
        );
        if (name && name.toLowerCase() !== id.toLowerCase()) {
          return `${name} interpretation`;
        }
      } catch {
        // not a language code after all; fall through to the plain name
      }
    }
    const words = id.replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
}
