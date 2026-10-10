import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { isUUID } from 'class-validator';
import { InjectDb } from '../../database/database';
import type { Db } from '../../database/database';
import { AppException } from '../errors/app-exception';
import type { AuthedRequest } from '../auth/auth';

/** Responses with these statuses are stored and replayed; other errors free the key for a retry. */
const REPLAYABLE_ERRORS = new Set(['PAYMENT_FAILED']);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * `Idempotency-Key` support (CONTRACTS §3): same key + same user + same request → the stored
 * result is replayed; same key with a different request → 409 IDEMPOTENCY_CONFLICT.
 * The key is optional; without it the request simply executes.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@InjectDb() private readonly db: Db) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');
    const userId = req.auth?.userId;
    if (!key || !userId) return next.handle();
    if (!isUUID(key)) {
      return throwError(() =>
        AppException.validation(
          { 'Idempotency-Key': ['must be a UUID'] },
          'The Idempotency-Key header must be a UUID.',
        ),
      );
    }
    const endpoint = `${req.method} ${req.baseUrl ?? ''}${req.path}`;
    const hash = createHash('sha256')
      .update(endpoint)
      .update('\n')
      .update(stableStringify(req.body ?? {}))
      .digest('hex');

    return from(this.claim(userId, key, endpoint, hash)).pipe(
      mergeMap((existing) => {
        if (existing) {
          res.setHeader('Idempotent-Replayed', 'true');
          if (existing.status >= 400) {
            const err = existing.body as {
              error: {
                code: string;
                message: string;
                details: Record<string, unknown>;
              };
            };
            return throwError(
              () => new AppException(err.error.code as never, err.error.message, err.error.details, existing.status),
            );
          }
          res.status(existing.status);
          return of(existing.body);
        }
        return next.handle().pipe(
          mergeMap((body: unknown) =>
            from(this.store(userId, key, res.statusCode || 200, body ?? null)).pipe(mergeMap(() => of(body))),
          ),
          catchError((err: unknown) => {
            if (err instanceof AppException && REPLAYABLE_ERRORS.has(err.code)) {
              const body = {
                error: {
                  code: err.code,
                  message: err.message,
                  details: err.details,
                },
              };
              return from(this.store(userId, key, err.status, body)).pipe(mergeMap(() => throwError(() => err)));
            }
            return from(this.release(userId, key)).pipe(mergeMap(() => throwError(() => err)));
          }),
        );
      }),
    );
  }

  /** Inserts the key as "in progress"; returns the stored response if it already completed. */
  private async claim(
    userId: string,
    key: string,
    endpoint: string,
    hash: string,
  ): Promise<{ status: number; body: unknown } | null> {
    const inserted = await this.db
      .insertInto('idempotency_keys')
      .values({ user_id: userId, key, endpoint, request_hash: hash })
      .onConflict((oc) => oc.columns(['user_id', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();
    if (inserted) return null;
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    if (row.endpoint !== endpoint || row.request_hash !== hash) {
      throw new AppException('IDEMPOTENCY_CONFLICT');
    }
    if (row.response_status === null) {
      throw new AppException('CONFLICT', 'This request is already being processed. Please wait a moment.');
    }
    return { status: row.response_status, body: row.response_body };
  }

  private async store(userId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({ response_status: status, response_body: JSON.stringify(body) })
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .execute();
  }

  private async release(userId: string, key: string): Promise<void> {
    await this.db.deleteFrom('idempotency_keys').where('user_id', '=', userId).where('key', '=', key).execute();
  }
}

/** Marks a handler as accepting an `Idempotency-Key` header. */
export const Idempotent = () =>
  applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description: 'UUID; reuse the same key when retrying the same user action.',
    }),
  );
