import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenVerifier, TrackType } from 'livekit-server-sdk';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import type { EditionAccessService } from '../common/edition-scope/edition-access.service';
import { AccessTier } from '../delegate/entities/delegate.entity';
import { SessionStatus } from '../sessions/entities/session.entity';
import type { SessionsService } from '../sessions/sessions.service';
import { LivekitService } from './livekit.service';
import { LISTEN_TOKEN_TTL_SEC, ListenService } from './listen.service';

/**
 * Room audio for the app: a real LiveKit token (signed with test keys and
 * verified back), granted to ticket holders and staff only, subscribe-only,
 * ten minutes, for the session's venue room.
 */
const KEY = 'APItestkey';
const SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
const EDITION = 'e0000000-0000-4000-8000-000000000001';

const user = (role: AccessTier = AccessTier.STANDARD): AuthUser => ({
  id: 'd0000000-0000-4000-8000-000000000001',
  role,
  jti: 'j',
  exp: 0,
});

function build(
  opts: {
    configured?: boolean;
    status?: SessionStatus;
    editionId?: string | null;
    holds?: boolean;
    features?: string[] | null;
    managed?: string[];
    tracks?: { name: string; type: TrackType }[] | Error;
  } = {},
) {
  const env: Record<string, string> =
    opts.configured === false
      ? {}
      : {
          LIVEKIT_URL: 'wss://pic.livekit.test',
          LIVEKIT_API_KEY: KEY,
          LIVEKIT_API_SECRET: SECRET,
        };
  const livekit = new LivekitService({
    get: (k: string) => env[k],
  } as unknown as ConfigService);
  const listParticipants = jest.fn(() =>
    opts.tracks instanceof Error
      ? Promise.reject(opts.tracks)
      : Promise.resolve([{ tracks: opts.tracks ?? [] }]),
  );
  jest
    .spyOn(livekit, 'roomServiceClient')
    .mockReturnValue({ listParticipants } as never);
  const sessions = {
    findById: jest.fn().mockResolvedValue({
      id: 's1',
      room: ' Main Hall ',
      status: opts.status ?? SessionStatus.LIVE,
      editionId: opts.editionId === undefined ? EDITION : opts.editionId,
    }),
  };
  const dataSource = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM tickets')
          ? [{ holds: opts.holds ?? true }]
          : [
              {
                features:
                  opts.features === undefined ? ['audio'] : opts.features,
              },
            ],
      ),
    ),
  };
  const editionAccess = {
    editionsOf: jest.fn().mockResolvedValue(opts.managed ?? []),
  };
  const service = new ListenService(
    sessions as unknown as SessionsService,
    livekit,
    dataSource as unknown as DataSource,
    editionAccess as unknown as EditionAccessService,
  );
  return { service, dataSource, listParticipants };
}

describe('ListenService.grant', () => {
  it('mints a ten-minute, subscribe-only token for the venue room', async () => {
    const { service } = build();
    const before = Date.now();
    const grant = await service.grant('s1', user());

    expect(grant.url).toBe('wss://pic.livekit.test');
    expect(grant.room).toBe('audio:main hall');
    expect(grant.channels).toEqual([{ id: 'floor', label: 'Floor' }]);
    expect(grant.channel).toBe('floor');
    const expires = Date.parse(grant.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(
      LISTEN_TOKEN_TTL_SEC * 1000 - 50,
    );
    expect(expires - before).toBeLessThanOrEqual(
      LISTEN_TOKEN_TTL_SEC * 1000 + 1000,
    );

    const claims = await new TokenVerifier(KEY, SECRET).verify(grant.token);
    expect(claims.sub).toBe(user().id);
    expect(claims.video).toMatchObject({
      room: 'audio:main hall',
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(claims.exp! - claims.nbf!).toBe(LISTEN_TOKEN_TTL_SEC);
  });

  it('refuses someone without a ticket for the event, before saying whether it is live', async () => {
    const { service } = build({
      holds: false,
      status: SessionStatus.SCHEDULED,
    });
    await expect(service.grant('s1', user())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets staff in without a ticket; an event organiser only at their own events', async () => {
    await expect(
      build({ holds: false }).service.grant('s1', user(AccessTier.ADMIN)),
    ).resolves.toHaveProperty('token');
    await expect(
      build({ holds: false }).service.grant(
        's1',
        user(AccessTier.SESSION_ADMIN),
      ),
    ).resolves.toHaveProperty('token');
    await expect(
      build({ holds: false, managed: [EDITION] }).service.grant(
        's1',
        user(AccessTier.EVENT_ADMIN),
      ),
    ).resolves.toHaveProperty('token');
    await expect(
      build({ holds: false, managed: ['other'] }).service.grant(
        's1',
        user(AccessTier.EVENT_ADMIN),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('asks for no ticket for a session filed under no event', async () => {
    const { service, dataSource } = build({ editionId: null, holds: false });
    await expect(service.grant('s1', user())).resolves.toHaveProperty('token');
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('404s a session that is not live, or an event with audio switched off', async () => {
    await expect(
      build({ status: SessionStatus.COMPLETED }).service.grant('s1', user()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ features: ['captions'] }).service.grant('s1', user()),
    ).rejects.toThrow('not offered');
  });

  it('503s when LiveKit is not configured', async () => {
    await expect(
      build({ configured: false }).service.grant('s1', user()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists the audio tracks on air as channels, floor first', async () => {
    const { service } = build({
      tracks: [
        { name: 'fr', type: TrackType.AUDIO },
        { name: 'floor', type: TrackType.AUDIO },
        { name: 'camera', type: TrackType.VIDEO },
        { name: 'ha', type: TrackType.AUDIO },
      ],
    });
    const grant = await service.grant('s1', user(), 'fr');
    expect(grant.channels).toEqual([
      { id: 'floor', label: 'Floor' },
      { id: 'fr', label: 'French interpretation' },
      { id: 'ha', label: 'Hausa interpretation' },
    ]);
    expect(grant.channel).toBe('fr');
    await expect(service.grant('s1', user(), 'yo')).rejects.toThrow(
      'not on air',
    );
  });

  it('calls a single track, whatever its name, the floor', async () => {
    const { service } = build({
      tracks: [{ name: 'microphone', type: TrackType.AUDIO }],
    });
    const grant = await service.grant('s1', user());
    expect(grant.channels).toEqual([{ id: 'microphone', label: 'Floor' }]);
  });

  it('falls back to the floor when the room cannot be read', async () => {
    const { service } = build({ tracks: new Error('room not found') });
    const grant = await service.grant('s1', user());
    expect(grant.channels).toEqual([{ id: 'floor', label: 'Floor' }]);
  });
});
