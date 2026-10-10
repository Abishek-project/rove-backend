import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';
const toInt = ({ value }: { value: unknown }) => (value === undefined || value === '' ? undefined : Number(value));

/**
 * Every environment variable the backend reads. Validated once at boot; the app refuses to
 * start with a clear message if something is missing or malformed.
 */
export class EnvVars {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 4000;

  /** Comma-separated list of allowed browser origins. */
  @IsString()
  CORS_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

  @IsUrl({ require_tld: false, require_protocol: true })
  SUPABASE_URL: string;

  /** Service-role (or `sb_secret_…`) key. Server-side only — never sent to clients. */
  @IsString()
  @MinLength(20)
  SUPABASE_SERVICE_ROLE_KEY: string;

  /** Anon / publishable key — used only by the seed + e2e tests to sign in like a client. */
  @IsOptional()
  @IsString()
  SUPABASE_ANON_KEY?: string;

  /** HS256 fallback secret for verifying legacy symmetric Supabase JWTs. */
  @IsOptional()
  @IsString()
  SUPABASE_JWT_SECRET?: string;

  /** Expected `iss` claim. Empty = don't check issuer (aud + exp + signature still checked). */
  @IsOptional()
  @IsString()
  SUPABASE_JWT_ISSUER?: string;

  /**
   * Base URL used when building public/signed Storage URLs returned to clients, if clients reach
   * Supabase under a different host than the backend does (e.g. Android emulator → 10.0.2.2).
   */
  @IsOptional()
  @IsString()
  STORAGE_PUBLIC_URL?: string;

  @IsString()
  DATABASE_URL: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  DB_POOL_MAX = 10;

  @IsIn(['mock'])
  PAYMENT_PROVIDER = 'mock' as const;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 120;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  THROTTLE_WRITE_LIMIT = 60;

  @Transform(toInt)
  @IsInt()
  @Min(1000)
  THROTTLE_TTL_MS = 60_000;

  @Transform(toBool)
  @IsBoolean()
  ENABLE_CRON = true;

  @Transform(toInt)
  @IsInt()
  @Min(60)
  SIGNED_URL_TTL_SECONDS = 600;

  @IsIn(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' = 'log';

  /** Only used by `npm run seed` (and e2e tests). Never used by the running API. */
  @IsOptional()
  @IsString()
  SEED_USER_PASSWORD?: string;
}

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const env = plainToInstance(EnvVars, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const lines = errors.map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`);
    throw new Error(`Invalid environment configuration (see .env.example):\n${lines.join('\n')}`);
  }
  return env;
}
