import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { sessionUserId } from '../utils/query.js';
import { BOOK_ID_PATTERN } from '../utils/contactBookFilter.js';

const router = Router(); router.use(requireAuth);
interface Preferences { selectedIds: string[] | null; collapsedSourceIds: string[] }
async function read(userId: string): Promise<Preferences> {
  const [user, books] = await Promise.all([
    query<{ presentation: Partial<Preferences> | null }>("SELECT preferences->'contactsPresentation' AS presentation FROM users WHERE id = $1", [userId]),
    query<{ id: string }>('SELECT id FROM address_books WHERE user_id = $1', [userId]),
  ]);
  const data = user.rows[0]?.presentation; const owned = new Set(books.rows.map(book => book.id));
  return { selectedIds: Array.isArray(data?.selectedIds) ? [...new Set(data.selectedIds.filter(id => typeof id === 'string' && owned.has(id)))] : null,
    collapsedSourceIds: Array.isArray(data?.collapsedSourceIds) ? data.collapsedSourceIds.filter(id => typeof id === 'string' && id.length <= 256) : [] };
}
router.get('/', async (req, res) => {
  try { res.json(await read(sessionUserId(req))); }
  catch { res.status(500).json({ code: 'PRESENTATION_READ_FAILED', error: 'Could not read contact presentation' }); }
});
router.patch('/', async (req, res) => {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ code: 'INVALID_PRESENTATION', error: 'Invalid presentation' });
  const input = body as Record<string, unknown>; const patch: Partial<Preferences> = {};
  if (Object.keys(input).some(key => key !== 'selectedIds' && key !== 'collapsedSourceIds') || !Object.keys(input).length) return res.status(400).json({ code: 'INVALID_PRESENTATION', error: 'Invalid presentation fields' });
  if (Object.prototype.hasOwnProperty.call(input, 'selectedIds')) {
    if (input.selectedIds === null) patch.selectedIds = null;
    else if (Array.isArray(input.selectedIds) && input.selectedIds.length <= 500 && input.selectedIds.every(id => typeof id === 'string' && BOOK_ID_PATTERN.test(id))) patch.selectedIds = [...new Set((input.selectedIds as string[]).map(id => id.toLowerCase()))];
    else return res.status(400).json({ code: 'INVALID_BOOK_FILTER', error: 'Invalid book selection' });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'collapsedSourceIds')) {
    // Opaque presentation keys do not grant access. The client groups only owned books;
    // these user-scoped strings are never used to fetch another user's connection.
    if (!Array.isArray(input.collapsedSourceIds) || input.collapsedSourceIds.length > 500 || !input.collapsedSourceIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(id))) return res.status(400).json({ code: 'INVALID_PRESENTATION', error: 'Invalid source preference' });
    patch.collapsedSourceIds = [...new Set(input.collapsedSourceIds as string[])];
  }
  const userId = sessionUserId(req);
  try {
    if (patch.selectedIds?.length) {
      const owned = await query<{ id: string }>('SELECT id FROM address_books WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, patch.selectedIds]);
      if (owned.rows.length !== patch.selectedIds.length) return res.status(403).json({ code: 'BOOK_NOT_AVAILABLE', error: 'A selected book is not available' });
    }
    // One row lock / atomic jsonb merge; never overwrite unrelated preferences or
    // the other presentation field using an old snapshot from the browser.
    await query(`UPDATE users SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{contactsPresentation}',
      (CASE WHEN jsonb_typeof(preferences->'contactsPresentation') = 'object' THEN preferences->'contactsPresentation' ELSE '{}'::jsonb END) || $2::jsonb, true) WHERE id = $1`, [userId, JSON.stringify(patch)]);
    res.json(await read(userId));
  } catch { res.status(500).json({ code: 'PRESENTATION_WRITE_FAILED', error: 'Could not save contact presentation' }); }
});
export default router;
