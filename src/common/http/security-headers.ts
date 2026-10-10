import type { NextFunction, Request, Response } from 'express';

/** Minimal security headers for a JSON API (no helmet dependency needed). */
export default function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (req.path.startsWith('/api/v1')) res.setHeader('Cache-Control', 'no-store');
  next();
}
