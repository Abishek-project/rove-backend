import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth';

/** Rate limits per authenticated user (falls back to client IP for anonymous calls). */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const r = req as AuthedRequest;
    return Promise.resolve(r.auth?.userId ? `u:${r.auth.userId}` : `ip:${r.ip}`);
  }

  protected shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return Promise.resolve(ctx.getType() !== 'http');
  }
}
