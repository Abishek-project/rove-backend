import { INestApplication } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { HealthController } from './modules/health/health.controller';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmetLike from './common/http/security-headers';
import { AppConfig } from './config/app-config';

/** Shared by main.ts and the e2e tests so both run the exact same pipeline. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  app.setGlobalPrefix('api/v1');
  // CONTRACTS §9.1: health is also served outside the /api/v1 prefix.
  const health = app.get(HealthController);
  const http = app.getHttpAdapter();
  http.get('/health', (_req: unknown, res: ExpressResponse) => {
    void health.check().then((body) => res.status(body.db === 'ok' ? 200 : 503).json(body));
  });
  app.enableCors({
    origin: config.corsOrigins,
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed', 'Content-Disposition'],
    maxAge: 600,
  });
  app.use(helmetLike);
  const express = app.getHttpAdapter().getInstance() as {
    disable?: (k: string) => void;
    set?: (k: string, v: unknown) => void;
  };
  express.disable?.('x-powered-by');
  express.set?.('trust proxy', 'loopback');
}

export function setupSwagger(app: INestApplication): void {
  const doc = new DocumentBuilder()
    .setTitle('Rove API')
    .setDescription(
      'Rove car rental marketplace backend (India INR / UAE AED). Contract: shared/CONTRACTS.md. ' +
        'All responses use `{ data, meta? }`; errors use `{ error: { code, message, details, requestId } }`.',
    )
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Supabase access token',
    })
    .addServer('http://localhost:4000')
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
}
