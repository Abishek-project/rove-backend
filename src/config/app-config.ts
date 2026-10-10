import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from './env';

/** Typed accessor over the validated environment. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  get<K extends keyof EnvVars>(key: K): EnvVars[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  get supabaseUrl(): string {
    return this.get('SUPABASE_URL').replace(/\/$/, '');
  }

  get jwtIssuer(): string | undefined {
    const iss = this.get('SUPABASE_JWT_ISSUER');
    return iss ? iss : undefined;
  }
}
