import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { MockPaymentProvider } from '../payments/mock-payment.provider';
import { PAYMENT_PROVIDER } from '../payments/payment-provider';
import { StorageService } from '../storage/storage.service';
import { AuthGuard, AuthService } from './auth/auth';
import { JwtVerifier } from './auth/jwt-verifier';
import { IdempotencyInterceptor } from './http/idempotency';

@Global()
@Module({
  providers: [
    AppConfig,
    JwtVerifier,
    AuthService,
    AuthGuard,
    StorageService,
    IdempotencyInterceptor,
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfig],
      // Only the mock exists in v1; a Stripe provider would be selected here by PAYMENT_PROVIDER.
      useFactory: () => new MockPaymentProvider(),
    },
  ],
  exports: [AppConfig, JwtVerifier, AuthService, AuthGuard, StorageService, IdempotencyInterceptor, PAYMENT_PROVIDER],
})
export class CommonModule {}
