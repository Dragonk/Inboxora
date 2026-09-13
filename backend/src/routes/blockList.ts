import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM block_list WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to load block list' });
  }
});

router.post('/', async (req, res) => {
  const { emailAddress } = req.body;
  if (!emailAddress || typeof emailAddress !== 'string' || !emailAddress.trim()) {
    return res.status(400).json({ error: 'emailAddress is required' });
  }
  try {
    const result = await query(
      `INSERT INTO block_list (user_id, email_address)
       VALUES ($1, $2)
       ON CONFLICT (user_id, email_address) DO NOTHING
       RETURNING *`,
      [req.session.userId, emailAddress.trim().toLowerCase()]
    );
    const row = result.rows[0] ?? (
      await query('SELECT * FROM block_list WHERE user_id = $1 AND email_address = $2',
        [req.session.userId, emailAddress.trim().toLowerCase()])
    ).rows[0];
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /block-list error:', err.message);
    res.status(500).json({ error: 'Failed to add to block list' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM block_list WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.session.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /block-list/:id error:', err.message);
    res.status(500).json({ error: 'Failed to remove from block list' });
  }
});

export default router;
