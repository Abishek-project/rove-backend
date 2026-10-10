import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { Page, WithMeta } from './page';

export const RAW_RESPONSE = 'rove:rawResponse';
/** Skip the `{ data }` envelope (CSV export, health). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

/** Wraps successful responses in `{ data, meta? }` (CONTRACTS §3). */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [ctx.getHandler(), ctx.getClass()]);
    if (raw) return next.handle();
    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined) return undefined; // 204
        if (body instanceof Page) return { data: body.items, meta: body.meta };
        if (body instanceof WithMeta) return { data: body.data as unknown, meta: body.meta };
        return { data: body };
      }),
    );
  }
}
