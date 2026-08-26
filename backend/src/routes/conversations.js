import { Router } from 'express';
import { query, pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveConversationAlias } from '../services/conversationOverridePolicy.js';
import { sanitizeEmail, blockRemoteImages, hasRemoteImages, shouldBlockRemoteImages } from '../services/emailSanitizer.js';
import { isUuid, uuidParam } from '../utils/uuid.js';
import { applyConversationAction, applyBulkConversationAction } from '../services/conversationActions.js';
import { normalizeMessageId } from '../services/threading/normalizeMessageId.js';

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
  const {
    accountId,
    folder: requestedFolder,
    limit = 50,
    cursor,
    search,
    unreadOnly,
    category,
    searchAllFolders,
    unifiedInbox,
  } = req.query;
  // Match the native list's search-all-folders behavior: when explicitly enabled,
  // search is not constrained to the currently selected folder.
  const folder = searchAllFolders === '1' ? undefined : requestedFolder;
  const cursorValue = decodeCursor(cursor);
  if (cursor && !cursorValue) return res.status(400).json({ error: 'Invalid conversation cursor' });
  const values = accountId ? [userId, accountId] : [userId];
  // Folder/account scope applies to every list aggregate, not only conversation
  // existence. Filter parameters are allocated once and reused by all projections.
  const folderParam = values.length + 1;
  if (folder) values.push(folder);
  const categoryParam = category && category !== 'all' ? values.push(category) : null;
  const searchParam = search && String(search).trim() ? values.push(`%${String(search).trim()}%`) : null;
  const scopedFilters = (alias, includeFolder = true) => {
    const filters = [];
    if (accountId) filters.push(`${alias}.account_id = $2`);
    if (unifiedInbox === '1' && !accountId) {
      filters.push(`EXISTS (SELECT 1 FROM email_accounts scoped_account WHERE scoped_account.id = ${alias}.account_id AND scoped_account.user_id = $1 AND scoped_account.include_in_unified_inbox = true)`);
    }
    if (includeFolder && folder) filters.push(`${alias}.folder = $${folderParam}`);
    if (unreadOnly === '1' || unreadOnly === 'true') filters.push(`${alias}.is_read = false`);
    if (categoryParam) filters.push(`COALESCE(${alias}.category, 'primary') = $${categoryParam}`);
    if (searchParam) filters.push(`(${alias}.subject ILIKE $${searchParam} OR ${alias}.snippet ILIKE $${searchParam} OR ${alias}.from_email ILIKE $${searchParam})`);
    return filters.length ? ` AND ${filters.join(' AND ')}` : '';
  };
  const scopedMessageFilter = scopedFilters('m');
  const scopedLogicalFilter = scopedFilters('visible_lm', false);
  const scopedPreviewFilter = scopedFilters('m');
  const scopedPreviewOrder = folder ? `CASE WHEN m.folder = $${folderParam} THEN 0 ELSE 1 END,` : '';
  let cursorFilter = '';
  if (cursorValue) {
    values.push(cursorValue.date, cursorValue.id);
    cursorFilter = `AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
  }
  values.push(parseLimit(limit));
  const limitParam = values.length;
  const result = await query(`
    SELECT c.id AS conversation_id, c.kind, c.canonical_subject,
           MIN(m.date) AS first_message_at, MAX(m.date) AS last_message_at,
           COUNT(DISTINCT m.logical_message_id)::int AS logical_message_count,
           COUNT(m.id)::int AS copy_count,
           COUNT(DISTINCT m.logical_message_id) FILTER (WHERE m.is_read = false)::int AS unread_count,
           c.threading_confidence,
           COALESCE(BOOL_OR(m.is_starred), false) AS is_starred,
           COUNT(DISTINCT m.id)::int AS visible_copy_count,
           COALESCE(MAX(m.date), c.created_at) AS sort_date,
           BOOL_OR(COALESCE(m.has_attachments, false)) AS has_attachments,
           BOOL_OR(latest.direction IN ('outgoing', 'self')) FILTER (WHERE latest.id IS NOT NULL) AS latest_message_is_mine,
           COALESCE(preview.logical_messages, '[]'::jsonb) AS logical_messages,
           top_latest.id AS latest_copy_id
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.account_id = c.account_id AND m.is_deleted = false ${scopedMessageFilter}
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
        ${unifiedInbox === '1' && !accountId ? 'AND a.include_in_unified_inbox = true' : ''}
      LEFT JOIN LATERAL (
        SELECT lm.direction, lm.id
          FROM logical_messages lm
         WHERE lm.conversation_id = c.id
           AND EXISTS (SELECT 1 FROM messages visible_lm WHERE visible_lm.logical_message_id = lm.id AND visible_lm.is_deleted = false ${scopedLogicalFilter})
         ORDER BY lm.message_date DESC NULLS LAST, lm.id DESC
         LIMIT 1
      ) latest ON true
     LEFT JOIN LATERAL (
       SELECT m.id
         FROM messages m
        WHERE m.conversation_id = c.id AND m.is_deleted = false ${scopedMessageFilter}
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
            ${scopedPreviewFilter}
          ORDER BY ${scopedPreviewOrder} m.is_read ASC, m.date DESC NULLS LAST, m.id DESC
          LIMIT 1
       ) latest_copy ON true
       WHERE lm.conversation_id = c.id
         AND EXISTS (SELECT 1 FROM messages visible_lm WHERE visible_lm.logical_message_id = lm.id AND visible_lm.is_deleted = false ${scopedLogicalFilter})
     ) preview ON true
     WHERE c.user_id = $1
       AND (${accountId ? 'c.account_id = $2' : 'true'})
       AND NOT EXISTS (SELECT 1 FROM conversation_aliases ca WHERE ca.user_id = $1 AND ca.alias_conversation_id = c.id)
       ${cursorFilter}
     GROUP BY c.id, top_latest.id, preview.logical_messages
     ORDER BY COALESCE(MAX(m.date), c.created_at) DESC, c.id DESC
     LIMIT $${limitParam}
  `, values);
  for (const row of result.rows) row.latestCopyId = row.latest_copy_id;
  const nextCursor = result.rows.length === parseLimit(limit) ? encodeCursor(result.rows.at(-1)) : null;
  res.json({ conversations: result.rows, nextCursor });
});

router.get('/conversations/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const owned = await client.query('SELECT account_id FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const accountId = owned.rows[0].account_id;
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, accountId, conversationId: req.params.id });
    const result = await client.query(`
      SELECT c.*, lm.id AS logical_id, lm.canonical_message_id, lm.subject,
             lm.direction, lm.message_date, lm.threading_reason, lm.threading_confidence,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', m.id, 'accountId', m.account_id, 'folder', m.folder,
               'messageId', m.message_id, 'canonicalMessageId', m.canonical_message_id,
               'subject', m.subject, 'fromName', m.from_name, 'fromEmail', m.from_email,
               'to', m.to_addresses, 'cc', m.cc_addresses, 'date', m.date,
               'snippet', m.snippet, 'replyTo', m.reply_to, 'inReplyTo', m.in_reply_to, 'references', m.thread_references, 'attachments', m.attachments,
               'listUnsubscribe', m.list_unsubscribe, 'listUnsubscribePost', m.list_unsubscribe_post, 'unsubscribedAt', m.unsubscribed_at,
               'isRead', m.is_read, 'isStarred', m.is_starred,
               'providerMessageId', m.provider_message_id, 'providerThreadId', m.provider_thread_id,
               'providerNamespace', m.provider_namespace,
               'deliveryAddresses', m.delivery_addresses
             ) ORDER BY m.date ASC NULLS LAST, m.id) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS copies
        FROM conversations c
        LEFT JOIN logical_messages lm ON lm.conversation_id = c.id AND lm.account_id = c.account_id
        LEFT JOIN messages m ON m.logical_message_id = lm.id AND m.conversation_id = c.id AND m.is_deleted = false
       WHERE c.id = $1 AND c.user_id = $2 AND c.account_id = $3
       GROUP BY c.id, lm.id
       ORDER BY lm.message_date ASC NULLS LAST, lm.id
    `, [canonicalId, req.session.userId, accountId]);
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
    const owned = await client.query('SELECT account_id FROM conversations WHERE id = $1 AND user_id = $2', [req.params.conversationId, req.session.userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Logical message body not found' });
    const accountId = owned.rows[0].account_id;
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, accountId, conversationId: req.params.conversationId });
    const result = await client.query(`
      SELECT lm.id, m.body_text, m.body_html, m.attachments, m.id AS physical_copy_id, m.account_id, m.folder, u.preferences, m.from_email
        FROM logical_messages lm
        JOIN messages m ON m.logical_message_id = lm.id AND m.conversation_id = $3 AND m.is_deleted = false
        JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $2
        JOIN users u ON u.id = a.user_id
       WHERE lm.id = $1 AND lm.user_id = $2 AND lm.account_id = $5 AND lm.conversation_id = $3
       AND ($4::uuid IS NULL OR m.id = $4::uuid)
       ORDER BY (m.body_html IS NOT NULL OR m.body_text IS NOT NULL) DESC, m.is_read ASC, m.date DESC NULLS LAST, m.id DESC
       LIMIT 1
    `, [req.params.logicalMessageId, req.session.userId, canonicalId, req.query.copyId || null, accountId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Logical message body not found' });
    const requestedRemoteImages = req.query.remoteImages === '1';
    const explicitOptIn = req.get('X-MailFlow-Image-Opt-In') === '1';
    const policyBlocksImages = shouldBlockRemoteImages(result.rows[0].preferences, result.rows[0]);
    // The stored preference/whitelist is the default policy. A one-time frontend
    // opt-in can only loosen it when the request carries the explicit header; this
    // mirrors the legacy body route without allowing a bare query parameter to bypass
    // privacy settings.
    const remoteImages = requestedRemoteImages && explicitOptIn && !policyBlocksImages;
    const rawHtml = result.rows[0].body_html;
    const html = rawHtml && !remoteImages && hasRemoteImages(rawHtml)
      ? blockRemoteImages(sanitizeEmail(rawHtml))
      : (rawHtml ? sanitizeEmail(rawHtml) : rawHtml);
    res.json({ ...result.rows[0], body_html: html, remoteImages, hasBlockedRemoteImages: Boolean(rawHtml && html !== rawHtml) });
  } finally { client.release(); }
});

// Resolve the canonical reader selection from either a physical-copy UUID or a
// durable RFC Message-ID reference. `:ref` deliberately does not use the generic
// `:id` UUID guard: deep links and integration selections use RFC Message-ID values.
// A UUID remains copy-exact. A Message-ID is first normalized with the CE canonical
// normalizer, then candidates are restricted to the requested managed account before
// ambiguity is evaluated. Copy preference is permitted only after the account-local
// LogicalMessage/conversation identity is proven unique.
router.get('/messages/:ref/conversation', async (req, res) => {
  const ref = req.params.ref;
  const byPhysicalCopy = isUuid(ref);
  const canonicalMessageId = byPhysicalCopy ? null : normalizeMessageId(ref);
  const requestedAccountId = req.query.accountId || null;
  if (!byPhysicalCopy && !canonicalMessageId) {
    return res.status(400).json({ error: 'Invalid message reference' });
  }
  if (!byPhysicalCopy && !isUuid(requestedAccountId)) {
    return res.status(400).json({ error: 'accountId is required for RFC Message-ID resolution', code: 'ACCOUNT_REQUIRED' });
  }

  const result = await query(byPhysicalCopy ? `
    SELECT m.id, m.account_id, m.folder, m.date, m.conversation_id, m.logical_message_id
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
  ` : `
    SELECT m.id, m.account_id, m.folder, m.date, m.conversation_id, m.logical_message_id
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
     WHERE m.canonical_message_id = $1 AND a.user_id = $2 AND m.account_id = $3::uuid AND m.is_deleted = false
     ORDER BY (m.folder = 'INBOX') DESC, m.date DESC NULLS LAST, m.id DESC
  `, byPhysicalCopy ? [ref, req.session.userId] : [canonicalMessageId, req.session.userId, requestedAccountId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
  if (byPhysicalCopy) {
    if (!result.rows[0].conversation_id) return res.status(404).json({ error: 'Conversation not found' });
    return res.json(result.rows[0]);
  }

  // SQL has already removed every cross-account candidate. Only distinct identities
  // inside the requested account participate in ambiguity evaluation.
  const identities = new Set(result.rows.map(row => `${row.logical_message_id || ''}:${row.conversation_id || ''}`));
  const ambiguous = identities.size !== 1
    || !result.rows[0].logical_message_id
    || !result.rows[0].conversation_id;
  if (ambiguous) {
    return res.status(409).json({ error: 'Conversation reference is ambiguous', code: 'CONVERSATION_REFERENCE_AMBIGUOUS' });
  }
  // The SQL order selects the preferred physical representation only after the
  // preceding identity check established that every live candidate is the same message.
  return res.json(result.rows[0]);
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
      imapManager: req.app.get('imapManager'),
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
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, items: req.body?.items, scope: req.body?.scope || 'THIS_COPY', action: 'archive', imapManager: req.app.get('imapManager') })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-delete', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, items: req.body?.items, scope: req.body?.scope || 'THIS_COPY', action: 'delete', imapManager: req.app.get('imapManager') })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-read', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, items: req.body?.items, scope: req.body?.scope || 'THIS_COPY', action: 'read', isRead: req.body?.isRead, imapManager: req.app.get('imapManager') })); }
  catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
});
router.post('/conversations/bulk-move', async (req, res) => {
  try { res.json(await applyBulkConversationAction({ userId: req.session.userId, conversationIds: req.body?.conversationIds, items: req.body?.items, scope: req.body?.scope || 'THIS_COPY', action: 'move', targetFolder: req.body?.targetFolder, imapManager: req.app.get('imapManager') })); }
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
    const owned = await client.query('SELECT account_id FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const accountId = owned.rows[0].account_id;
    const canonicalId = await resolveConversationAlias(client, { userId: req.session.userId, accountId, conversationId: req.params.id });
    const conv = await client.query(
      'SELECT id, kind, canonical_subject, threading_confidence, manually_locked, logical_message_count, unread_count, copy_count FROM conversations WHERE id = $1 AND user_id = $2 AND account_id = $3',
      [canonicalId, req.session.userId, accountId]
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
