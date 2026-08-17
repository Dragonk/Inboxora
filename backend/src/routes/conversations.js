import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveConversationAlias } from '../services/conversationOverridePolicy.js';
import { pool } from '../services/db.js';

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
  return Buffer.from(JSON.stringify({ date: row.sort_date, id: row.conversation_id })).toString('base64url');
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
    cursorFilter = `AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  values.push(parseLimit(limit));
  const limitParam = values.length;
  const result = await query(`
    SELECT c.id AS conversation_id, c.kind, c.canonical_subject,
           c.first_message_at, c.last_message_at, c.logical_message_count,
           c.copy_count, c.unread_count, c.threading_confidence,
           COUNT(DISTINCT m.id)::int AS visible_copy_count,
           COALESCE(c.last_message_at, c.created_at) AS sort_date,
           BOOL_OR(COALESCE(m.has_attachments, false)) AS has_attachments,
           BOOL_OR(latest.direction IN ('outgoing', 'self')) FILTER (WHERE latest.id IS NOT NULL) AS latest_message_is_mine,
           COALESCE(preview.logical_messages, '[]'::jsonb) AS logical_messages
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.is_deleted = false
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      LEFT JOIN LATERAL (
        SELECT lm.direction, lm.id
          FROM logical_messages lm
         WHERE lm.conversation_id = c.id
         ORDER BY lm.message_date DESC NULLS LAST, lm.id DESC
         LIMIT 1
      ) latest ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', lm.id, 'subject', lm.subject, 'canonicalSubject', lm.canonical_subject,
         'direction', lm.direction, 'messageDate', lm.message_date, 'snippet', latest_copy.snippet, 'fromName', latest_copy.from_name, 'fromEmail', latest_copy.from_email,
         'unread', COALESCE(latest_copy.unread, false), 'accountId', latest_copy.account_id,
         'hasAttachments', COALESCE(latest_copy.has_attachments, false), 'latestCopyId', latest_copy.id,
         'isLatest', lm.id = latest.id
       ) ORDER BY lm.message_date ASC NULLS LAST, lm.id) AS logical_messages
       FROM logical_messages lm
       LEFT JOIN LATERAL (
         SELECT m.id, m.snippet, m.from_name, m.from_email, m.account_id, m.has_attachments, NOT m.is_read AS unread
           FROM messages m WHERE m.logical_message_id = lm.id AND m.is_deleted = false
           ORDER BY m.is_read ASC, m.date DESC NULLS LAST, m.id DESC LIMIT 1
       ) latest_copy ON true
       WHERE lm.conversation_id = c.id
     ) preview ON true
     WHERE c.user_id = $1 ${accountFilter} ${cursorFilter}
     GROUP BY c.id
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
     LIMIT $${limitParam}
  `, values);
  const nextCursor = result.rows.length === parseLimit(limit) ? encodeCursor(result.rows.at(-1)) : null;
  res.json({ conversations: result.rows, nextCursor });
});

router.get('/conversations/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, conversationId: req.params.id });
    const result = await client.query(`
      SELECT c.*, lm.id AS logical_id, lm.canonical_message_id, lm.subject,
             lm.direction, lm.message_date, lm.threading_reason, lm.threading_confidence,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', m.id, 'accountId', m.account_id, 'folder', m.folder,
               'messageId', m.message_id, 'canonicalMessageId', m.canonical_message_id,
               'subject', m.subject, 'fromName', m.from_name, 'fromEmail', m.from_email,
               'to', m.to_addresses, 'cc', m.cc_addresses, 'date', m.date,
               'snippet', m.snippet, 'replyTo', m.reply_to, 'inReplyTo', m.in_reply_to, 'references', m.thread_references, 'attachments', m.attachments,
               'isRead', m.is_read, 'isStarred', m.is_starred,
               'providerMessageId', m.provider_message_id, 'providerThreadId', m.provider_thread_id,
               'providerNamespace', m.provider_namespace
             ) ORDER BY m.date ASC NULLS LAST, m.id) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS copies
        FROM conversations c
        LEFT JOIN logical_messages lm ON lm.conversation_id = c.id
        LEFT JOIN messages m ON m.logical_message_id = lm.id AND m.is_deleted = false
       WHERE c.id = $1 AND c.user_id = $2
       GROUP BY c.id, lm.id
       ORDER BY lm.message_date ASC NULLS LAST, lm.id
    `, [canonicalId, req.session.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const logicalRows = result.rows.filter(row => row.logical_id).map(row => ({
      id: row.logical_id, canonicalMessageId: row.canonical_message_id, subject: row.subject,
      direction: row.direction, messageDate: row.message_date, threadingReason: row.threading_reason,
      threadingConfidence: row.threading_confidence, copies: row.copies || [],
    }));
    const first = result.rows[0];
    const summary = Object.fromEntries(Object.entries(first).filter(([key]) => !['logical_id', 'canonical_message_id', 'subject', 'direction', 'message_date', 'threading_reason', 'threading_confidence'].includes(key)));
    res.json({ summary: { ...summary, conversation_id: canonicalId, requested_conversation_id: req.params.id }, logicalMessages: logicalRows });
  } finally { client.release(); }
});

router.get('/conversations/:conversationId/logical-messages/:logicalMessageId/body', async (req, res) => {
  const client = await pool.connect();
  try {
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, conversationId: req.params.conversationId });
    const result = await client.query(`
      SELECT lm.id, m.body_text, m.body_html, m.attachments
        FROM logical_messages lm
        JOIN messages m ON m.logical_message_id = lm.id AND m.is_deleted = false
       WHERE lm.id = $1 AND lm.user_id = $2 AND lm.conversation_id = $3
       ORDER BY m.is_read ASC, m.date DESC NULLS LAST, m.id DESC
       LIMIT 1
    `, [req.params.logicalMessageId, req.session.userId, canonicalId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Logical message body not found' });
    res.json(result.rows[0]);
  } finally { client.release(); }
});

router.get('/messages/:id/conversation', async (req, res) => {
  const result = await query(`
    SELECT m.conversation_id, m.logical_message_id
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
  `, [req.params.id, req.session.userId]);
  if (!result.rows.length || !result.rows[0].conversation_id) return res.status(404).json({ error: 'Conversation not found' });
  res.json(result.rows[0]);
});

export default router;
