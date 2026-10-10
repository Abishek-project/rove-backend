import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth/auth';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { EnvelopeInterceptor } from './common/http/envelope.interceptor';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { UserThrottlerGuard } from './common/http/throttle';
import { createValidationPipe } from './common/http/validation';
import { AppConfig } from './config/app-config';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database';
import { FeatureModules } from './modules/feature-modules';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    ScheduleModule.forRoot(),
    CommonModule,
    DatabaseModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_LIMIT'),
          },
          {
            name: 'write',
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_WRITE_LIMIT'),
            skipIf: (ctx) =>
              ['GET', 'HEAD', 'OPTIONS'].includes(ctx.switchToHttp().getRequest<{ method: string }>().method),
          },
        ],
      }),
    }),
    ...FeatureModules,
  ],
  providers: [
    // Order matters: authenticate first so rate limits are tracked per user.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
