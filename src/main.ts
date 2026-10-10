import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import { AppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfig);
  const levels = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
  app.useLogger(levels.slice(0, levels.indexOf(config.get('LOG_LEVEL')) + 1));
  configureApp(app);
  setupSwagger(app);
  app.enableShutdownHooks();
  const port = config.get('PORT');
  await app.listen(port);
  new Logger('Bootstrap').log(`Rove API listening on http://localhost:${port} (docs: /api/docs)`);
}

void bootstrap();
