import { Router } from 'express';
import { query, pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveConversationAlias } from '../services/conversationOverridePolicy.js';
import { uuidParam } from '../utils/uuid.js';
import { applyConversationAction, applyBulkConversationAction } from '../services/conversationActions.js';

const router = Router();
router.use(requireAuth);

// Reuse the upstream uuidParam guard so malformed conversation/logical-message IDs
// return 400, not a Postgres 500 from a failed uuid cast.
router.param('id', uuidParam('id'));
router.param('conversationId', uuidParam('conversationId'));
router.param('logicalMessageId', uuidParam('logicalMessageId'));

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
  const { accountId, folder, limit = 50, cursor } = req.query;
  const cursorValue = decodeCursor(cursor);
  if (cursor && !cursorValue) return res.status(400).json({ error: 'Invalid conversation cursor' });
  const values = accountId ? [userId, accountId] : [userId];
  const accountFilter = accountId ? `AND m.account_id = $2` : '';
  // Folder-scoped filtering: a conversation appears in the list only if it has at
  // least one visible physical copy in the requested folder. The expanded children
  // still show the FULL conversation (all folders), but the list is scoped.
  const folderFilter = folder ? `AND EXISTS (SELECT 1 FROM messages mf WHERE mf.conversation_id = c.id AND mf.is_deleted = false ${accountId ? 'AND mf.account_id = $2' : ''} AND mf.folder = $${values.length + 1})` : '';
  if (folder) { values.push(folder); }
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
           COALESCE(BOOL_OR(m.is_starred), false) AS is_starred,
           COUNT(DISTINCT m.id)::int AS visible_copy_count,
           COALESCE(c.last_message_at, c.created_at) AS sort_date,
           BOOL_OR(COALESCE(m.has_attachments, false)) AS has_attachments,
           BOOL_OR(latest.direction IN ('outgoing', 'self')) FILTER (WHERE latest.id IS NOT NULL) AS latest_message_is_mine,
           COALESCE(preview.logical_messages, '[]'::jsonb) AS logical_messages,
           top_latest.id AS latest_copy_id
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.is_deleted = false
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      LEFT JOIN LATERAL (
        SELECT lm.direction, lm.id
          FROM logical_messages lm
         WHERE lm.conversation_id = c.id
           AND EXISTS (SELECT 1 FROM messages visible_lm WHERE visible_lm.logical_message_id = lm.id AND visible_lm.is_deleted = false ${accountId ? 'AND visible_lm.account_id = $2' : ''})
         ORDER BY lm.message_date DESC NULLS LAST, lm.id DESC
         LIMIT 1
      ) latest ON true
     LEFT JOIN LATERAL (
       SELECT m.id
         FROM messages m
        WHERE m.conversation_id = c.id AND m.is_deleted = false ${accountFilter}${folder ? ` AND m.folder = $${accountId ? 3 : 2}` : ''}
        ORDER BY m.date DESC NULLS LAST, m.id DESC
        LIMIT 1
     ) top_latest ON true
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
         SELECT m.id, m.snippet, m.from_name, m.from_email, m.account_id,
                m.has_attachments, NOT m.is_read AS unread
           FROM messages m
          WHERE m.logical_message_id = lm.id
            AND m.is_deleted = false
            ${accountId ? 'AND m.account_id = $2' : ''}
          ORDER BY m.is_read ASC, m.date DESC NULLS LAST, m.id DESC
          LIMIT 1
       ) latest_copy ON true
       WHERE lm.conversation_id = c.id
         AND EXISTS (SELECT 1 FROM messages visible_lm WHERE visible_lm.logical_message_id = lm.id AND visible_lm.is_deleted = false ${accountId ? 'AND visible_lm.account_id = $2' : ''})
     ) preview ON true
     WHERE c.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM conversation_aliases ca WHERE ca.user_id = $1 AND ca.alias_conversation_id = c.id)
       ${accountFilter} ${folderFilter} ${cursorFilter}
     GROUP BY c.id, top_latest.id, preview.logical_messages
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
     LIMIT $${limitParam}
  `, values);
  for (const row of result.rows) row.latestCopyId = row.latest_copy_id;
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
               'providerNamespace', m.provider_namespace,
               'deliveryAddresses', m.delivery_addresses
             ) ORDER BY m.date ASC NULLS LAST, m.id) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS copies
        FROM conversations c
        LEFT JOIN logical_messages lm ON lm.conversation_id = c.id
        LEFT JOIN messages m ON m.logical_message_id = lm.id AND m.conversation_id = c.id AND m.is_deleted = false
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
      SELECT lm.id, m.body_text, m.body_html, m.attachments, m.id AS physical_copy_id, m.account_id, m.folder
        FROM logical_messages lm
        JOIN messages m ON m.logical_message_id = lm.id AND m.conversation_id = $3 AND m.is_deleted = false
        JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $2
       WHERE lm.id = $1 AND lm.user_id = $2 AND lm.conversation_id = $3
       AND ($4::uuid IS NULL OR m.id = $4::uuid)
       ORDER BY (m.body_html IS NOT NULL OR m.body_text IS NOT NULL) DESC, m.is_read ASC, m.date DESC NULLS LAST, m.id DESC
       LIMIT 1
    `, [req.params.logicalMessageId, req.session.userId, canonicalId, req.query.copyId || null]);
    if (!result.rows.length) return res.status(404).json({ error: 'Logical message body not found' });
    // Match the legacy message-body endpoint's remote-image contract. The stored
    // body remains the same; the flag is explicit so the frontend can distinguish
    // a privacy-blocked fetch from an opt-in fetch and apply one shared renderer policy.
    res.json({ ...result.rows[0], remoteImages: req.query.remoteImages === '1' });
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

// ── Copy-aware actions ─────────────────────────────────────────────────────────
// These routes are deliberately separate from legacy /messages/bulk-* routes.
// Every CE action requires an explicit scope and is tenant-scoped by session user.

async function runAction(req, res, action, extra = {}) {
  try {
    const result = await applyConversationAction({
      userId: req.session.userId,
      conversationId: req.params.id,
      scope: req.body?.scope || 'THIS_COPY',
      copyId: req.body?.copyId || null,
      logicalMessageId: req.body?.logicalMessageId || null,
      action,
      ...extra,
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
}

router.post('/conversations/:id/archive', (req, res) => runAction(req, res, 'archive'));
router.post('/conversations/:id/delete', (req, res) => runAction(req, res, 'delete'));
router.post('/conversations/:id/move', (req, res) => runAction(req, res, 'move', { targetFolder: req.body?.targetFolder }));
router.post('/conversations/:id/read', (req, res) => runAction(req, res, 'read', { isRead: req.body?.isRead }));
router.post('/conversations/:id/star', (req, res) => runAction(req, res, 'star', { isStarred: req.body?.isStarred }));

router.post('/conversations/bulk-archive', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, scope: req.body?.scope || 'THIS_COPY', action: 'archive' })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-delete', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, scope: req.body?.scope || 'THIS_COPY', action: 'delete' })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-read', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, scope: req.body?.scope || 'THIS_COPY', action: 'read', isRead: req.body?.isRead })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-move', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, scope: req.body?.scope || 'THIS_COPY', action: 'move', targetFolder: req.body?.targetFolder })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});

export default router;

// ── Manual operations ──────────────────────────────────────────────────────────
// Merge, split, move, lock, unlock, force include/exclude — all operate on the
// CE v2 conversation model and respect tenant ownership.

import { applyConversationOverride } from '../services/conversationOverrides.js';

// Merge: merge source conversation into target. Delegates to the service layer
// which handles alias resolution, cycle guard, deterministic locks, provider
// mappings, evidence reconciliation, overrides reconciliation, aggregate
// refresh, and cross-conversation edge protection.
router.post('/conversations/:id/merge', async (req, res) => {
  const { targetConversationId } = req.body || {};
  if (!targetConversationId) return res.status(400).json({ error: 'targetConversationId required' });
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      overrideType: 'manual-merge',
      targetId: targetConversationId,
    });
    res.json({ merged: true, ...result });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: 'Merge failed', detail: err.message });
  }
});

// Split: split a logical message (and optionally its replies) into a new conversation.
// Delegates to the service layer which handles kind='manual_conversation',
// cross-conversation edge cleanup, and aggregate refresh.
router.post('/conversations/:id/logical-messages/:logicalMessageId/split', async (req, res) => {
  const { includeReplies = false } = req.body || {};
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      logicalMessageId: req.params.logicalMessageId,
      scope: includeReplies ? 'message-with-descendants' : 'message-only',
      overrideType: 'manual-split',
    });
    res.status(201).json({ split: true, newConversationId: result.targetId, ...result });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: 'Split failed', detail: err.message });
  }
});

// Move a logical message to a different conversation. Delegates to the service
// layer which handles cross-conversation edge cleanup and aggregate refresh.
router.post('/conversations/:id/logical-messages/:logicalMessageId/move', async (req, res) => {
  const { targetConversationId } = req.body || {};
  if (!targetConversationId) return res.status(400).json({ error: 'targetConversationId required' });
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      logicalMessageId: req.params.logicalMessageId,
      overrideType: 'manual-move',
      targetId: targetConversationId,
    });
    res.json({ moved: true, ...result });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: 'Move failed', detail: err.message });
  }
});

// Lock/unlock conversation — delegates to service which uses manually_locked.
router.post('/conversations/:id/lock', async (req, res) => {
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      overrideType: 'lock-conversation',
    });
    res.json({ locked: true, ...result });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: 'Lock failed', detail: err.message });
  }
});

router.post('/conversations/:id/unlock', async (req, res) => {
  try {
    const result = await applyConversationOverride({
      userId: req.session.userId,
      conversationId: req.params.id,
      overrideType: 'unlock-conversation',
    });
    res.json({ locked: false, ...result });
  } catch (err) {
    const status = err.statusCode || 400;
    res.status(status).json({ error: 'Unlock failed', detail: err.message });
  }
});

// Force include/exclude a logical message in/from a conversation
router.post('/conversations/:id/logical-messages/:logicalMessageId/force-include', async (req, res) => {
  const result = await applyConversationOverride({
    userId: req.session.userId,
    conversationId: req.params.id,
    logicalMessageId: req.params.logicalMessageId,
    scope: 'message-only',
    overrideType: 'force-include',
    targetConversationId: req.body?.targetConversationId || req.body?.targetId || req.params.id,
  });
  res.status(201).json(result);
});

router.post('/conversations/:id/logical-messages/:logicalMessageId/force-exclude', async (req, res) => {
  const result = await applyConversationOverride({
    userId: req.session.userId,
    conversationId: req.params.id,
    logicalMessageId: req.params.logicalMessageId,
    scope: 'message-only',
    overrideType: 'force-exclude',
  });
  res.status(201).json(result);
});

// Diagnostics: "Why is this grouped?"
router.get('/conversations/:id/diagnostics', async (req, res) => {
  const client = await pool.connect();
  try {
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, conversationId: req.params.id });
    const conv = await client.query(
      'SELECT id, kind, canonical_subject, threading_confidence, manually_locked, logical_message_count, unread_count, copy_count FROM conversations WHERE id = $1 AND user_id = $2',
      [canonicalId, req.session.userId]
    );
    if (!conv.rows.length) return res.status(404).json({ error: 'Conversation not found' });

    const logicalMessages = await client.query(
      `SELECT lm.id, lm.canonical_message_id, lm.subject, lm.direction, lm.message_date,
              lm.threading_reason, lm.threading_confidence, lm.parent_logical_message_id,
              COUNT(m.id)::int AS copy_count
         FROM logical_messages lm
         LEFT JOIN messages m ON m.logical_message_id = lm.id AND m.is_deleted = false
        WHERE lm.conversation_id = $1 AND lm.user_id = $2
        GROUP BY lm.id
        ORDER BY lm.message_date ASC NULLS LAST, lm.id`,
      [canonicalId, req.session.userId]
    );

    const overrides = await client.query(
      'SELECT * FROM conversation_overrides WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at DESC',
      [canonicalId, req.session.userId]
    );

    res.json({
      conversation: conv.rows[0],
      logicalMessages: logicalMessages.rows.map(row => ({
        ...row,
        // Include raw Message-ID and provider identity for debugging
        providerMessageId: null, // populated from messages if needed
      })),
      overrides: overrides.rows,
    });
  } finally {
    client.release();
  }
});
