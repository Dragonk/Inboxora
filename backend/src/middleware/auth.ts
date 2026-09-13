import { query } from '../services/db.js';
import type { NextFunction, Request, Response } from 'express';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
