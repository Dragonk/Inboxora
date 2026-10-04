import { searchMail } from '../services/mailSearch.js';
export { resolveSearchFolderScope, shouldExcludeTrashFromSearch, trashFolderExclusionCondition, freeTextTermCondition, FTS_BODY_CHAR_CAP } from '../services/mailSearch.js';
import { sessionUserId } from '../utils/query.js';
export { parseSearchQuery } from "../services/mailSearchQuery.js";
export interface SearchQuery {
  type: string;
  clauses: { type: string; term: string }[];
}

export function parseSearchQueryLocal(raw: string) {
  const query: SearchQuery = { type: 'all', clauses: [] };
  const tokens = raw.match(/([^\s"]+)|"([^"]*)"/g) || [];
  for (const token of tokens) {
    if (token.startsWith('"') && token.endsWith('"')) {
      query.clauses.push({ type: 'freetext', term: token.slice(1, -1) });
    } else {
      query.clauses.push({ type: 'freetext', term: token });
    }
  }
  return query;
}

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { toAppError } from '../utils/errors.js';
import { queryString } from '../utils/query.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();
router.use(requireAuth);

// Simple in-memory rate limiter: 120 searches per minute per user.
const searchBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of searchBuckets) {
    if (now > b.resetAt) searchBuckets.delete(k);
  }
}, 60_000).unref();

function searchLimiter(req: Request, res: Response, next: NextFunction) {
  const key = sessionUserId(req);
  const now = Date.now();
  const b = searchBuckets.get(key);
  if (!b || now > b.resetAt) {
    searchBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (b.count >= 120) {
    res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many search requests. Try again shortly.' });
  }
  b.count++;
  next();
}

router.get('/', searchLimiter, async (req: Request, res: Response) => {
  try { res.json(await searchMail(sessionUserId(req), req.query)); }
  catch (error) {
    const problem = toAppError(error);
    res.status(problem.statusCode === 400 ? 400 : 500).json({ error: problem.statusCode === 400 ? problem.message : 'Search failed' });
  }
});

// Contact autocomplete — returns up to 10 addresses matching the query.
// Priority: addresses the user has sent to (contacts table, ranked by send_count)
// come first; inbound-only senders from messages fill remaining slots, with
// obvious bulk/no-reply addresses filtered out.
router.get('/contacts', searchLimiter, async (req: Request, res: Response) => {
  const q = queryString(req.query.q) ?? '';
  const trimmed = q.trim();
  if (!trimmed || trimmed.length < 2) return res.json({ contacts: [] });
  if (trimmed.length > 100) return res.status(400).json({ error: 'Query too long' });

  const accountsResult = await query<{ id: string }>(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [sessionUserId(req)]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ contacts: [] });

  const pattern = `%${trimmed}%`;

  try {
    const result = await query(`
      WITH known AS (
        -- Contacts the user explicitly sent to or manually created (is_auto = false)
        SELECT primary_email AS email, display_name AS name, send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = false
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
      ),
      auto AS (
        -- Auto-discovered inbound contacts not already in known
        SELECT primary_email AS email, display_name AS name, 0 AS send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = true
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
          AND lower(primary_email) NOT IN (SELECT lower(email) FROM known)
      ),
      inbound AS (
        -- Fallback: senders not yet in contacts table, excluding bulk/robot
        SELECT email, name, send_count, last_sent
        FROM (
          SELECT DISTINCT ON (from_email)
            from_email AS email,
            from_name  AS name,
            0          AS send_count,
            date       AS last_sent,
            is_bulk
          FROM messages
          WHERE account_id = ANY($3)
            AND is_deleted = false
            AND from_email IS NOT NULL AND from_email != ''
            AND (from_email ILIKE $2 OR from_name ILIKE $2)
            AND lower(from_email) NOT IN (
              SELECT lower(primary_email) FROM contacts WHERE user_id = $1 AND primary_email IS NOT NULL
            )
            AND from_email !~* '^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@'
          ORDER BY from_email, date DESC
        ) latest
        WHERE is_bulk IS NOT TRUE
      )
      SELECT email, name
      FROM (
        SELECT email, name, 1 AS priority, send_count, last_sent FROM known
        UNION ALL
        SELECT email, name, 2 AS priority, 0, last_sent FROM auto
        UNION ALL
        SELECT email, name, 3 AS priority, 0, last_sent FROM inbound
      ) combined
      ORDER BY priority, send_count DESC, last_sent DESC NULLS LAST
      LIMIT 10
    `, [sessionUserId(req), pattern, userAccountIds]);

    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('Contact suggest error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

export default router;
