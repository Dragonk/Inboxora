import type { NextFunction, Request, Response } from 'express';
// Canonical UUID matcher and an Express router.param guard.
//
// Several routes take a UUID path param (:id, :aliasId, ...) and pass it straight into a
// uuid-typed SQL comparison. Without validation a malformed value raises a Postgres cast
// error that surfaces as a 500 (via express-async-errors) instead of a clean 400. Registering
// `router.param('id', uuidParam('id'))` converts that into a 400 before any query runs.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Factory for a router.param callback: (req, res, next, value) => 400 on a malformed UUID.
export function uuidParam(name: string) {
  return (req: Request, res: Response, next: NextFunction, value: string): void => {
    if (!isUuid(value)) {
      res.status(400).json({ error: `Invalid ${name}` });
      return;
    }
    next();
  };
}
