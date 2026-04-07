import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('[R2 Error]', err.message);
  const clientMessage = process.env.NODE_ENV === 'production'
    ? 'An internal error occurred'
    : err.message;
  res.status(500).json({ error: clientMessage });
}
