import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  IngressClient,
  RoomServiceClient,
  WebhookReceiver,
} from 'livekit-server-sdk';

/**
 * LiveKit room name for a venue's audio.
 *
 * Normalised, because the two callers reach this from opposite directions: a
 * publisher token is minted from whatever room string the capture operator
 * typed, while a listener token is minted from the room stored on the session.
 * `findLiveInRoom` already matches those loosely (LOWER/TRIM), so without the
 * same normalisation here " Main Hall " and "Main Hall" mint tokens for two
 * different LiveKit rooms: the delegate joins an empty one and hears silence,
 * with nothing logged anywhere to explain it.
 */
export const audioRoom = (room: string) => `audio:${room.trim().toLowerCase()}`;

@Injectable()
export class LivekitService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Delegate: subscribe-only access to a venue room's audio. No media, no
   * data messages (LiveKit allows data unless told otherwise) and no
   * metadata of their own - a listener can hear the room and nothing else.
   */
  listenerToken(
    room: string,
    delegateId: string,
    ttlSeconds?: number,
  ): Promise<string> {
    return this.mint(
      room,
      delegateId,
      {
        canPublish: false,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        canSubscribe: true,
      },
      ttlSeconds,
    );
  }

  /** Admin capture device: publish-only. */
  publisherToken(room: string, adminId: string): Promise<string> {
    return this.mint(room, `capture:${adminId}`, {
      canPublish: true,
      canSubscribe: false,
    });
  }

  /**
   * The API itself, listening to a venue stream (ingest/). Hidden, so it is
   * neither shown to delegates in the room nor counted as a listener.
   */
  ingestListenerToken(room: string, instanceId: string): Promise<string> {
    return this.mint(room, `captions:${instanceId}`, {
      canPublish: false,
      canSubscribe: true,
      hidden: true,
    });
  }

  /** Manages the venue streams' ingresses. */
  ingressClient(): IngressClient {
    return new IngressClient(
      this.requireConfig('LIVEKIT_URL'),
      this.requireConfig('LIVEKIT_API_KEY'),
      this.requireConfig('LIVEKIT_API_SECRET'),
    );
  }

  /** Reads who is in a room and what they publish (the listen channels). */
  roomServiceClient(): RoomServiceClient {
    return new RoomServiceClient(
      this.requireConfig('LIVEKIT_URL'),
      this.requireConfig('LIVEKIT_API_KEY'),
      this.requireConfig('LIVEKIT_API_SECRET'),
    );
  }

  /** Verifies LiveKit's webhook signature (a JWT over the body's hash). */
  webhookReceiver(): WebhookReceiver {
    return new WebhookReceiver(
      this.requireConfig('LIVEKIT_API_KEY'),
      this.requireConfig('LIVEKIT_API_SECRET'),
    );
  }

  /** True when all three LiveKit settings are present. */
  isConfigured(): boolean {
    return ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].every(
      (key) => !!this.config.get<string>(key),
    );
  }

  serverUrl(): string {
    return this.requireConfig('LIVEKIT_URL');
  }

  private mint(
    room: string,
    identity: string,
    grants: {
      canPublish: boolean;
      canSubscribe: boolean;
      canPublishData?: boolean;
      canUpdateOwnMetadata?: boolean;
      hidden?: boolean;
    },
    ttlSeconds?: number,
  ): Promise<string> {
    const at = new AccessToken(
      this.requireConfig('LIVEKIT_API_KEY'),
      this.requireConfig('LIVEKIT_API_SECRET'),
      { identity, ttl: ttlSeconds ?? '2h' },
    );
    at.addGrant({ room: audioRoom(room), roomJoin: true, ...grants });
    return at.toJwt();
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value)
      throw new ServiceUnavailableException('Live audio is not configured');
    return value;
  }
}
