import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function parseLimit(value) {
  return Math.min(Math.max(Number(value) || 50, 1), 100);
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed?.date || !parsed?.id) return null;
    return parsed;
  } catch { return null; }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ date: row.last_message_at, id: row.conversation_id })).toString('base64url');
}

router.get('/conversations', async (req, res) => {
  const userId = req.session.userId;
  const { accountId, limit = 50, cursor } = req.query;
  const cursorValue = decodeCursor(cursor);
  if (cursor && !cursorValue) return res.status(400).json({ error: 'Invalid conversation cursor' });
  const values = accountId ? [userId, accountId] : [userId];
  const accountFilter = accountId ? 'AND m.account_id = $2' : '';
  let cursorFilter = '';
  if (cursorValue) {
    values.push(cursorValue.date, cursorValue.id);
    cursorFilter = `AND (c.last_message_at, c.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  values.push(parseLimit(limit));
  const limitParam = values.length;
  const result = await query(`
    SELECT c.id AS conversation_id, c.kind, c.canonical_subject,
           c.first_message_at, c.last_message_at, c.logical_message_count,
           c.copy_count, c.unread_count, c.threading_confidence,
           COUNT(DISTINCT m.id)::int AS visible_copy_count,
           MAX(m.has_attachments::int)::boolean AS has_attachments
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.is_deleted = false
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
     WHERE c.user_id = $1 ${accountFilter} ${cursorFilter}
     GROUP BY c.id
     ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
     LIMIT $${limitParam}
  `, values);
  const nextCursor = result.rows.length === parseLimit(limit) ? encodeCursor(result.rows.at(-1)) : null;
  res.json({ conversations: result.rows, nextCursor });
});

router.get('/conversations/:id', async (req, res) => {
  const result = await query(`
    SELECT c.*, lm.id AS logical_id, lm.canonical_message_id, lm.subject,
           lm.direction, lm.message_date, lm.threading_reason, lm.threading_confidence
      FROM conversations c
      LEFT JOIN logical_messages lm ON lm.conversation_id = c.id
     WHERE c.id = $1 AND c.user_id = $2
     ORDER BY lm.message_date ASC NULLS LAST, lm.id
  `, [req.params.id, req.session.userId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
  const logicalRows = result.rows.filter(row => row.logical_id).map(row => ({
    id: row.logical_id, canonicalMessageId: row.canonical_message_id, subject: row.subject,
    direction: row.direction, messageDate: row.message_date, threadingReason: row.threading_reason,
    threadingConfidence: row.threading_confidence,
  }));
  const first = result.rows[0];
  const summary = first ? Object.fromEntries(Object.entries(first).filter(([key]) => !['logical_id', 'canonical_message_id', 'subject', 'direction', 'message_date', 'threading_reason', 'threading_confidence'].includes(key))) : {};
  res.json({ summary: { ...summary, conversation_id: first.id }, logicalMessages: logicalRows });
});

router.get('/messages/:id/conversation', async (req, res) => {
  const result = await query(`
    SELECT m.conversation_id, m.logical_message_id,
           c.id AS canonical_conversation_id
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
  `, [req.params.id, req.session.userId]);
  if (!result.rows.length || !result.rows[0].conversation_id) return res.status(404).json({ error: 'Conversation not found' });
  res.json(result.rows[0]);
});

export default router;
