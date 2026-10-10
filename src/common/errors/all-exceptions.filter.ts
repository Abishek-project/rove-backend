import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException, ErrorCode } from './app-exception';

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_FILE_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

interface PgError {
  code?: string;
  constraint?: string;
}

/** Renders every error as `{ error: { code, message, details, requestId } }` (CONTRACTS §3). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req as Request & { requestId?: string }).requestId;
    const app = this.toAppException(exception);

    if (app.status >= 500) {
      const err = exception as Error;
      this.logger.error(
        `${req.method} ${req.path} → ${app.status} [${requestId}] ${err?.message ?? String(exception)}`,
        err?.stack,
      );
    }

    if (res.headersSent) return;
    if (app.code === 'RATE_LIMITED' && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', '60');
    }
    res.status(app.status).json({
      error: {
        code: app.code,
        message: app.message,
        details: app.details,
        requestId,
      },
    });
  }

  private toAppException(exception: unknown): AppException {
    if (exception instanceof AppException) return exception;

    if (exception instanceof ThrottlerException) {
      return new AppException('RATE_LIMITED');
    }

    if (exception instanceof HttpException) {
      const status: number = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'object' && body && 'message' in body ? body.message : exception.message;
      if (status === 400 || status === 422) {
        // Body-parser JSON errors, multer field errors, etc.
        const text = Array.isArray(message) ? message.join('; ') : String(message);
        return new AppException('VALIDATION_FAILED', this.safeMessage(text, 'The request is invalid.'), {}, status);
      }
      const mapped = HTTP_TO_CODE[status];
      if (mapped) return new AppException(mapped, undefined, {}, status === 405 ? 404 : undefined);
      if (status < 500) return new AppException('VALIDATION_FAILED', undefined, {}, status);
      return new AppException('INTERNAL_ERROR');
    }

    // Postgres errors that escaped a service: map the common ones to safe codes.
    const pg = exception as PgError;
    if (pg && typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
      const map: Record<string, ErrorCode> = {
        '23P01': 'CONFLICT',
        '23505': 'CONFLICT',
        '23503': 'VALIDATION_FAILED',
        '23514': 'VALIDATION_FAILED',
        '22P02': 'VALIDATION_FAILED',
        '22007': 'VALIDATION_FAILED',
        '22008': 'VALIDATION_FAILED',
        '40001': 'CONFLICT',
        '40P01': 'CONFLICT',
        '57014': 'SERVICE_UNAVAILABLE',
      };
      if (pg.code === '23P01' && pg.constraint === 'bookings_no_overlap') {
        return new AppException('VEHICLE_UNAVAILABLE');
      }
      const code = map[pg.code];
      if (code) return new AppException(code);
      if (pg.code.startsWith('08')) return new AppException('SERVICE_UNAVAILABLE');
    }
    return new AppException('INTERNAL_ERROR');
  }

  private safeMessage(text: string, fallback: string): string {
    if (!text || text.length > 300) return fallback;
    if (/Unexpected token|JSON/i.test(text)) return 'The request body is not valid JSON.';
    return text;
  }
}
