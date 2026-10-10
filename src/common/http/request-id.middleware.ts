import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const CLIENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a client `x-request-id` if well-formed, otherwise generates `req_…`; echoes it back. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const id = incoming && CLIENT_ID.test(incoming) ? incoming : `req_${randomBytes(9).toString('base64url')}`;
    (req as Request & { requestId: string }).requestId = id;
    res.setHeader('x-request-id', id);
    next();
  }
}
