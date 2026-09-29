import { UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtStrategy } from '../../auth/strategies/jwt.stategies';
import { AuditInterceptor } from '../../common/audit.interceptor';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  configureBodyParsing,
  configureRouting,
} from '../../common/http/http-setup';
import { REDIS } from '../../common/redis/redis.module';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { SecurityService } from '../../security/security.service';
import {
  IngestController,
  LivekitWebhookController,
} from './ingest.controller';
import { IngestService } from './ingest.service';

const SECRET = 'test-secret';

/**
 * The venue-stream routes over real HTTP: the production body parsing and
 * routing (http-setup.ts), the real JWT, roles and audit layers, and a
 * mocked IngestService behind them.
 */
describe('Venue stream HTTP routes', () => {
  let app: NestExpressApplication;
  let jwt: JwtService;
  const ingest = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({
      room: 'Main Hall',
      input: 'whip',
      url: 'https://x/w',
      streamKey: 'secret-key',
    }),
    rotate: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    webhook: jest.fn().mockResolvedValue(undefined),
  };
  const security = { record: jest.fn().mockResolvedValue(undefined) };

  const token = (role: AccessTier) =>
    jwt.sign({ sub: `user-${role}`, role, jti: 'j1' }, { secret: SECRET });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: SECRET })],
        }),
        PassportModule,
        JwtModule.register({}),
      ],
      controllers: [IngestController, LivekitWebhookController],
      providers: [
        JwtStrategy,
        { provide: REDIS, useValue: { get: jest.fn() } },
        { provide: IngestService, useValue: ingest },
        { provide: SecurityService, useValue: security },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
      logger: false,
    });
    configureBodyParsing(app);
    configureRouting(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/v1/livekit/webhook', () => {
    it('hands the exact bytes and signature to the service, without a user token', async () => {
      const body = '{"event":"ingress_started", "id":"EV_1"}';
      await request(app.getHttpServer())
        .post('/api/v1/livekit/webhook')
        .set('Content-Type', 'application/webhook+json')
        .set('Authorization', 'signed-jwt')
        .send(body)
        .expect(200, { ok: true });
      // byte for byte, spacing included: the signature is over a hash of them
      expect(ingest.webhook).toHaveBeenCalledWith(body, 'signed-jwt');
    });

    it('answers 401 to a bad signature', async () => {
      ingest.webhook.mockRejectedValueOnce(
        new UnauthorizedException('Bad webhook signature'),
      );
      await request(app.getHttpServer())
        .post('/api/v1/livekit/webhook')
        .set('Content-Type', 'application/webhook+json')
        .send('{}')
        .expect(401);
    });
  });

  describe('/api/v1/ingest/rooms', () => {
    it('needs a signed-in organiser or caption operator to list', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/v1/ingest/rooms').expect(401);
      await request(server)
        .get('/api/v1/ingest/rooms')
        .set('Authorization', `Bearer ${token(AccessTier.STANDARD)}`)
        .expect(403);
      await request(server)
        .get('/api/v1/ingest/rooms')
        .set('Authorization', `Bearer ${token(AccessTier.SESSION_ADMIN)}`)
        .expect(200, []);
    });

    it('lets only organisers create a stream, and audits it without the key', async () => {
      const server = app.getHttpServer();
      await request(server)
        .post('/api/v1/ingest/rooms/Main%20Hall')
        .set('Authorization', `Bearer ${token(AccessTier.SESSION_ADMIN)}`)
        .send({ input: 'whip' })
        .expect(403);
      expect(ingest.create).not.toHaveBeenCalled();

      const res = await request(server)
        .post('/api/v1/ingest/rooms/Main%20Hall')
        .set('Authorization', `Bearer ${token(AccessTier.ADMIN)}`)
        .send({ input: 'whip' })
        .expect(201);
      expect(res.body).toMatchObject({ streamKey: 'secret-key' });
      expect(ingest.create).toHaveBeenCalledWith('Main Hall', 'whip', true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(security.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ingest_created',
          actorId: `user-${AccessTier.ADMIN}`,
        }),
      );
      expect(JSON.stringify(security.record.mock.calls)).not.toContain(
        'secret-key',
      );
    });

    it('rejects an unknown input or extra fields', async () => {
      const server = app.getHttpServer();
      const auth = `Bearer ${token(AccessTier.ADMIN)}`;
      await request(server)
        .post('/api/v1/ingest/rooms/Hall%20A')
        .set('Authorization', auth)
        .send({ input: 'srt' })
        .expect(400);
      await request(server)
        .post('/api/v1/ingest/rooms/Hall%20A')
        .set('Authorization', auth)
        .send({ streamKey: 'mine' })
        .expect(400);
      expect(ingest.create).not.toHaveBeenCalled();
    });

    it('removes a stream with 204', async () => {
      await request(app.getHttpServer())
        .delete('/api/v1/ingest/rooms/Hall%20A')
        .set('Authorization', `Bearer ${token(AccessTier.ADMIN)}`)
        .expect(204);
      expect(ingest.remove).toHaveBeenCalledWith('Hall A');
    });
  });

  it('still parses ordinary JSON bodies', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/rooms/Hall%20A/rotate')
      .set('Authorization', `Bearer ${token(AccessTier.ADMIN)}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ diarise: false }))
      .expect(201);
    expect(ingest.rotate).toHaveBeenCalledWith('Hall A', undefined, false);
  });
});
