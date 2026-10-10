import { HttpStatus } from '@nestjs/common';

/** Error codes from CONTRACTS §3. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PARTNER_NOT_APPROVED'
  | 'PARTNER_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VEHICLE_UNAVAILABLE'
  | 'QUOTE_EXPIRED'
  | 'HOLD_EXPIRED'
  | 'INVALID_STATE_TRANSITION'
  | 'AVAILABILITY_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PARTNER_ALREADY_EXISTS'
  | 'PAYMENT_FAILED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  PARTNER_NOT_APPROVED: HttpStatus.FORBIDDEN,
  PARTNER_REQUIRED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  VEHICLE_UNAVAILABLE: HttpStatus.CONFLICT,
  QUOTE_EXPIRED: HttpStatus.CONFLICT,
  HOLD_EXPIRED: HttpStatus.CONFLICT,
  INVALID_STATE_TRANSITION: HttpStatus.CONFLICT,
  AVAILABILITY_CONFLICT: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  PARTNER_ALREADY_EXISTS: HttpStatus.CONFLICT,
  PAYMENT_FAILED: HttpStatus.PAYMENT_REQUIRED,
  FILE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  UNSUPPORTED_FILE_TYPE: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
  SERVICE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Some fields are invalid.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You do not have permission to do that.',
  PARTNER_NOT_APPROVED: 'Your rental company must be approved before you can do this.',
  PARTNER_REQUIRED: 'You need a rental company profile to access this.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  VEHICLE_UNAVAILABLE: 'This vehicle is no longer available for the selected dates.',
  QUOTE_EXPIRED: 'This price quote has expired. Please get a new quote.',
  HOLD_EXPIRED: 'Your booking hold has expired. Please start again.',
  INVALID_STATE_TRANSITION: 'This action is not allowed for this booking now.',
  AVAILABILITY_CONFLICT: 'The period overlaps existing bookings or blocks.',
  IDEMPOTENCY_CONFLICT: 'This idempotency key was already used with a different request.',
  PARTNER_ALREADY_EXISTS: 'You already belong to a rental company.',
  PAYMENT_FAILED: 'The payment could not be completed.',
  FILE_TOO_LARGE: 'The file is too large.',
  UNSUPPORTED_FILE_TYPE: 'This file type is not supported.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
};

/** The only exception type business code throws. Rendered as the contract error envelope. */
export class AppException extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: Record<string, unknown> = {},
    status?: number,
  ) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.status = status ?? DEFAULT_STATUS[code];
  }

  static validation(
    fields: Record<string, string[]>,
    message?: string,
    extra: Record<string, unknown> = {},
  ): AppException {
    return new AppException('VALIDATION_FAILED', message, {
      fields,
      ...extra,
    });
  }

  static notFound(what = 'resource'): AppException {
    return new AppException('NOT_FOUND', `The requested ${what} was not found.`);
  }
}
