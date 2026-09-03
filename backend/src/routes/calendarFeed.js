import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { consume } from '../services/rateLimiter.js';
import { hashCalendarFeedToken, issueCalendarFeedToken, serializeCalendarFeed } from '../services/calendarFeed.js';

const router = Router();
const PUBLIC_FAILURE_LIMIT = 30;
const PUBLIC_FAILURE_WINDOW_MS = 60 * 1000;
const invalidResponse = (res) => res.status(404).type('text').send('Not found');

async function failureResponse(req, res) {
  const limited = await consume(`calendar-feed:${req.ip}`, PUBLIC_FAILURE_LIMIT, PUBLIC_FAILURE_WINDOW_MS);
  if (limited.limited) res.setHeader('Retry-After', Math.ceil(limited.resetMs / 1000));
  return invalidResponse(res);
}

// Anonymous route: token shape is checked before hashing, and all failures share
// one response so a feed cannot be enumerated.
router.get(['/calendar/feeds/:token.ics', '/calendar/feeds/:token'], async (req, res) => {
  const hash = hashCalendarFeedToken(req.params.token);
  if (!hash) return failureResponse(req, res);
  const result = await query(
    `SELECT f.calendar_ids, c.name AS calendar_name, e.id, e.uid, e.summary, e.description,
            e.location, e.url, e.starts_at, e.ends_at, e.all_day
       FROM calendar_secret_feeds f
       JOIN calendars c ON c.id = ANY(f.calendar_ids) AND c.owner_user_id = f.owner_user_id
       LEFT JOIN calendar_events e ON e.calendar_id = c.id AND e.user_id = f.owner_user_id
      WHERE f.token_hash = $1 AND f.revoked_at IS NULL
      ORDER BY e.starts_at ASC NULLS LAST`,
    [hash],
  );
  if (!result.rows.length) return failureResponse(req, res);
  const events = result.rows.filter(row => row.id);
  const names = [...new Set(result.rows.map(row => row.calendar_name).filter(Boolean))];
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store, private', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  return res.send(serializeCalendarFeed(events, names.join(', ') || 'Inboxora'));
});

router.use('/api/calendar/feeds', requireAuth);
router.post('/api/calendar/feeds', async (req, res) => {
  const requested = Array.isArray(req.body?.calendarIds) ? [...new Set(req.body.calendarIds)] : [];
  if (!requested.length || requested.some(id => typeof id !== 'string')) return res.status(400).json({ error: 'calendarIds must contain at least one calendar' });
  const owned = await query('SELECT id, name FROM calendars WHERE id = ANY($1) AND owner_user_id = $2 ORDER BY created_at', [requested, req.session.userId]);
  if (owned.rows.length !== requested.length) return res.status(404).json({ error: 'Calendar not found' });
  const { token, hash } = issueCalendarFeedToken();
  const result = await query('INSERT INTO calendar_secret_feeds (owner_user_id, token_hash, calendar_ids) VALUES ($1, $2, $3) RETURNING id, calendar_ids, created_at', [req.session.userId, hash, requested]);
  const feed = result.rows[0];
  return res.status(201).json({ feed: { id: feed.id, calendarIds: feed.calendar_ids, createdAt: feed.created_at, url: `/calendar/feeds/${token}.ics` }, secret: token });
});

router.get('/api/calendar/feeds', async (req, res) => {
  const result = await query('SELECT id, calendar_ids, created_at, revoked_at FROM calendar_secret_feeds WHERE owner_user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
  return res.json({ feeds: result.rows.map(feed => ({ id: feed.id, calendarIds: feed.calendar_ids, createdAt: feed.created_at, revokedAt: feed.revoked_at })) });
});

router.delete('/api/calendar/feeds/:feedId', async (req, res) => {
  const result = await query('UPDATE calendar_secret_feeds SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND owner_user_id = $2 RETURNING id', [req.params.feedId, req.session.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Feed not found' });
  return res.status(204).end();
});

export default router;
