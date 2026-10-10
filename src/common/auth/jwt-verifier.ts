import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, JWTPayload, jwtVerify } from 'jose';
import { AppConfig } from '../../config/app-config';
import { AppException } from '../errors/app-exception';

export interface VerifiedToken {
  sub: string;
  email?: string;
}

/**
 * Verifies Supabase access tokens: asymmetric keys via the project's JWKS endpoint,
 * falling back to HS256 with SUPABASE_JWT_SECRET for legacy symmetric tokens.
 * Checks signature, `aud = authenticated`, `exp`, and `iss` when configured.
 */
@Injectable()
export class JwtVerifier {
  private readonly logger = new Logger(JwtVerifier.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly hsSecret?: Uint8Array;

  constructor(private readonly config: AppConfig) {
    this.jwks = createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    const secret = config.get('SUPABASE_JWT_SECRET');
    if (secret) this.hsSecret = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<VerifiedToken> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new AppException('UNAUTHENTICATED', 'Invalid access token.');
    }
    const options = {
      audience: 'authenticated',
      issuer: this.config.jwtIssuer,
      clockTolerance: 5,
    };
    let payload: JWTPayload;
    try {
      if (alg === 'HS256') {
        if (!this.hsSecret) throw new AppException('UNAUTHENTICATED');
        ({ payload } = await jwtVerify(token, this.hsSecret, {
          ...options,
          algorithms: ['HS256'],
        }));
      } else {
        ({ payload } = await jwtVerify(token, this.jwks, {
          ...options,
          algorithms: ['ES256', 'RS256', 'EdDSA'],
        }));
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AppException('UNAUTHENTICATED', 'Your session has expired.');
      }
      if (err instanceof joseErrors.JWKSTimeout || (err as Error)?.name === 'TypeError') {
        this.logger.warn(`JWKS unavailable: ${(err as Error).message}`);
      }
      throw new AppException('UNAUTHENTICATED', 'Invalid access token.');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AppException('UNAUTHENTICATED', 'Invalid access token.');
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  }
}
