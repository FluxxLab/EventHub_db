import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request parsing, shared by main.ts and the HTTP specs so a test exercises
 * exactly what production runs.
 *
 * LiveKit posts its webhooks as application/webhook+json, which the default
 * JSON parser skips - leaving no rawBody to verify the signature over. Same
 * parser, one more content type; rawBody (enabled in NestFactory.create for
 * the payment webhooks) still applies.
 */
export function configureBodyParsing(app: NestExpressApplication): void {
  app.useBodyParser('json', {
    type: ['application/json', 'application/webhook+json'],
  });
}

/** `/api/v1/...` routes and the global validation every DTO relies on. */
export function configureRouting(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
