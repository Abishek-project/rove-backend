import { ArgumentMetadata, Injectable, PipeTransform, ValidationError, ValidationPipe } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AppException } from '../errors/app-exception';

function collect(errors: ValidationError[], prefix: string, out: Record<string, string[]>): void {
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) {
      out[path] = [...(out[path] ?? []), ...Object.values(e.constraints)];
    }
    if (e.children?.length) collect(e.children, path, out);
  }
}

export function validationErrorsToFields(errors: ValidationError[]): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  collect(errors, '', fields);
  return fields;
}

/** Global DTO validation → `400 VALIDATION_FAILED` with `details.fields`. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) =>
      new AppException(
        'VALIDATION_FAILED',
        'Some fields are invalid.',
        { fields: validationErrorsToFields(errors) },
        400,
      ),
  });
}

/** Path-param UUID check: malformed ids are simply "not found". */
@Injectable()
export class UuidParam implements PipeTransform<string, string> {
  transform(value: string, meta: ArgumentMetadata): string {
    void meta;
    if (!isUUID(value)) throw AppException.notFound();
    return value.toLowerCase();
  }
}
