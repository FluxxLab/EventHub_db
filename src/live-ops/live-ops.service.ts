import { Inject, Injectable } from '@nestjs/common';
import { captureStatusKey } from '../captions/captions.service';
import Redis from 'ioredis';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { REDIS } from '../common/redis/redis.module';
import { SessionsService } from '../sessions/sessions.service';
import { CaptionLanguage } from '../captions/translation/languages';

const FLAG_KEYS = (sessionId: string) => ({
  cutToBreak: `liveops:cutToBreak:${sessionId}`,
  captionsOverlay: `liveops:captionsOverlay:${sessionId}`,
  signLanguageOverlay: `liveops:signLanguageOverlay:${sessionId}`,
});

export interface BroadcastFlags {
  cutToBreak: boolean;
  captionsOverlay: boolean;
  signLanguageOverlay: boolean;
}

@Injectable()
export class LiveOpsService {
  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
    private readonly sessionsService: SessionsService,
    private readonly realtime: RealtimeService,
  ) {}

  async overview() {
    const liveSessions = await this.sessionsService.findLiveNow();
    const sessions = await Promise.all(
      liveSessions.map(async (s) => ({
        id: s.id,
        title: s.title,
        room: s.room,
        viewers: await this.realtime.roomSize(Rooms.session(s.id)),
        captionListeners: await this.captionListeners(s.id),
        capturing: (await this.redis.exists(captureStatusKey(s.room))) === 1,
        flags: await this.getflags(s.id),
      })),
    );
    return { sessions };
  }

  async setCutToBreak(
    sessionId: string,
    active: boolean,
  ): Promise<BroadcastFlags> {
    await this.redis.set(FLAG_KEYS(sessionId).cutToBreak, active ? '1' : '0');
    return this.broadcastFlags(sessionId);
  }

  async setOverlays(
    sessionId: string,
    input: { captions?: boolean; signLanguage?: boolean },
  ): Promise<BroadcastFlags> {
    if (input.captions !== undefined) {
      await this.redis.set(
        FLAG_KEYS(sessionId).captionsOverlay,
        input.captions ? '1' : '0',
      );
    }
    if (input.signLanguage !== undefined) {
      await this.redis.set(
        FLAG_KEYS(sessionId).signLanguageOverlay,
        input.signLanguage ? '1' : '0',
      );
    }
    return this.broadcastFlags(sessionId);
  }

  async getflags(sessionId: string): Promise<BroadcastFlags> {
    const keys = FLAG_KEYS(sessionId);
    const [cut, cap, sign] = await this.redis.mget(
      keys.cutToBreak,
      keys.captionsOverlay,
      keys.signLanguageOverlay,
    );
    return {
      cutToBreak: cut === '1',
      captionsOverlay: cap === '1',
      signLanguageOverlay: sign === '1',
    };
  }

  private async broadcastFlags(sessionId: string): Promise<BroadcastFlags> {
    const flags = await this.getflags(sessionId);
    this.realtime.emitToRoom(
      Rooms.session(sessionId),
      'broadcast:flags',
      flags,
    );
    return flags;
  }

  /**
   * Listeners are spread across one room per caption language, so the
   * English room alone undercounts every delegate reading a translation.
   */
  private async captionListeners(sessionId: string): Promise<number> {
    const perLanguage = await Promise.all(
      Object.values(CaptionLanguage).map((language) =>
        this.realtime.roomSize(Rooms.caption(sessionId, language)),
      ),
    );
    return perLanguage.reduce((total, count) => total + count, 0);
  }
}
