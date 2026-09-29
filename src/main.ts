import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './common/realtime/redis-io.adapter';
import {
  configureBodyParsing,
  configureRouting,
} from './common/http/http-setup';
// default import: the package is CommonJS and `import * as` gives the
// module namespace, which is not callable under this tsconfig
import compression from 'compression';

async function bootstrap() {
  // rawBody: payment webhooks verify their signature over the exact bytes sent.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  configureBodyParsing(app);

  const config = app.get(ConfigService);

  /**
   * Trust the reverse proxy's X-Forwarded-For, so req.ip is the delegate's
   * address and not Caddy's. Without it every request would share one rate
   * limit bucket (the proxy's IP). A hop count rather than `true`, so a
   * client cannot spoof its IP by sending its own X-Forwarded-For.
   */
  app.set('trust proxy', config.get<number>('TRUST_PROXY_HOPS') ?? 1);
  app.useWebSocketAdapter(
    new RedisIoAdapter(
      app,
      config.getOrThrow<string>('REDIS_HOST'),
      config.getOrThrow<number>('REDIS_PORT'),
    ),
  );

  /**
   * Gzip every response.
   *
   * The programme alone is 111 KB of JSON and compresses to 20 KB. At the
   * summit venue the wifi measured around 0.55 Mbps, where that difference is
   * a second and a half per fetch, per delegate, on the one request every
   * screen depends on. Nothing here is large enough for compression to cost
   * more CPU than it saves.
   */
  app.use(compression());

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  configureRouting(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('GS-26 Summit API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
