import { withTransaction } from './db.js';
import { resolveConversationAlias } from './conversationOverridePolicy.js';

export const COPY_SCOPES = new Set([
  'THIS_COPY',
  'ALL_COPIES_OF_LOGICAL_MESSAGE',
  'COPIES_ON_THIS_ACCOUNT',
  'WHOLE_CONVERSATION',
]);

function assertScope(scope) {
  if (!COPY_SCOPES.has(scope)) {
    const error = new Error(`Unsupported copy scope: ${scope}`);
    error.statusCode = 400;
    throw error;
  }
}

function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map(String))];
}

/**
 * Resolve the physical rows affected by a CE action. THIS_COPY requires an
 * explicit physical copy id when the caller supplies one; for list rows the
 * deterministic latest visible copy is used as the selected copy.
 */
async function resolvePhysicalIds(client, { userId, conversationId, scope, copyId, logicalMessageId }) {
  assertScope(scope);
  const canonicalConversationId = await resolveConversationAlias(client, { userId, conversationId });
  const params = [userId, canonicalConversationId];
  let selector;
  if (copyId) {
    params.push(copyId);
    selector = `m.id = $3`;
  } else if (logicalMessageId) {
    params.push(logicalMessageId);
    selector = `m.logical_message_id = $3`;
  } else {
    selector = `m.id = (
      SELECT latest.id FROM messages latest
       JOIN email_accounts latest_account ON latest_account.id = latest.account_id
      WHERE latest.conversation_id = $2 AND latest_account.user_id = $1 AND latest.is_deleted = false
      ORDER BY latest.date DESC NULLS LAST, latest.id DESC LIMIT 1
    )`;
  }

  const selected = await client.query(
    `SELECT m.id, m.account_id, m.logical_message_id, m.conversation_id
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE m.conversation_id = $2 AND m.is_deleted = false AND ${selector}
      FOR UPDATE`,
    params,
  );
  if (!selected.rows.length) {
    const error = new Error('Selected copy not found or not owned by user');
    error.statusCode = 404;
    throw error;
  }

  const selectedRow = selected.rows[0];
  let where;
  let values = [userId];
  if (scope === 'THIS_COPY') {
    values.push(selectedRow.id);
    where = 'm.id = $2';
  } else if (scope === 'ALL_COPIES_OF_LOGICAL_MESSAGE') {
    if (!selectedRow.logical_message_id) {
      values.push(selectedRow.id);
      where = 'm.id = $2';
    } else {
      values.push(selectedRow.logical_message_id);
      where = 'm.logical_message_id = $2';
    }
  } else if (scope === 'COPIES_ON_THIS_ACCOUNT') {
    values.push(selectedRow.account_id, canonicalConversationId);
    where = 'm.account_id = $2 AND m.conversation_id = $3';
  } else {
    values.push(canonicalConversationId);
    where = 'm.conversation_id = $2';
  }

  const affected = await client.query(
    `SELECT m.id, m.account_id, m.logical_message_id, m.conversation_id, m.folder
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE m.is_deleted = false AND ${where}
      FOR UPDATE`,
    values,
  );
  return { canonicalConversationId, selected: selectedRow, rows: affected.rows };
}

export async function applyConversationAction({
  userId,
  conversationId,
  scope = 'THIS_COPY',
  copyId = null,
  logicalMessageId = null,
  action,
  isRead,
  isStarred,
  targetFolder,
}) {
  if (!userId) throw Object.assign(new Error('userId is required'), { statusCode: 400 });
  if (!conversationId) throw Object.assign(new Error('conversationId is required'), { statusCode: 400 });
  assertScope(scope);
  if (!['archive', 'move', 'delete', 'read', 'star'].includes(action)) {
    throw Object.assign(new Error(`Unsupported conversation action: ${action}`), { statusCode: 400 });
  }
  if ((action === 'move' || action === 'archive') && !targetFolder && action === 'move') {
    throw Object.assign(new Error('targetFolder required'), { statusCode: 400 });
  }

  return withTransaction(async client => {
    const resolved = await resolvePhysicalIds(client, {
      userId, conversationId, scope, copyId, logicalMessageId,
    });
    const ids = resolved.rows.map(row => row.id);
    let result;

    if (action === 'read') {
      result = await client.query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id, is_read', [!!isRead, ids]);
    } else if (action === 'star') {
      result = await client.query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id, is_starred', [!!isStarred, ids]);
    } else if (action === 'delete') {
      result = await client.query(`UPDATE messages SET is_deleted = true WHERE id = ANY($1::uuid[]) RETURNING id`, [ids]);
    } else if (action === 'archive') {
      result = await client.query(`UPDATE messages SET folder = 'Archive' WHERE id = ANY($1::uuid[]) RETURNING id, folder`, [ids]);
    } else {
      result = await client.query('UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[]) RETURNING id, folder', [targetFolder, ids]);
    }

    // Recompute aggregates for every affected conversation, including the source
    // conversation when a copy is moved/deleted and any destination is external.
    await client.query(
      `UPDATE conversations c SET
         logical_message_count = COALESCE((SELECT COUNT(DISTINCT m.logical_message_id) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = false), 0),
         copy_count = COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = false), 0),
         unread_count = COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = false AND NOT m.is_read), 0),
         last_message_at = (SELECT MAX(m.date) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = false),
         updated_at = NOW()
       WHERE c.id = $1 AND c.user_id = $2`,
      [resolved.canonicalConversationId, userId],
    );

    return {
      ok: true,
      action,
      scope,
      conversationId: resolved.canonicalConversationId,
      selectedCopyId: resolved.selected.id,
      affectedIds: result.rows.map(row => row.id),
      affectedCount: result.rowCount,
    };
  }, { serializable: true });
}

export async function applyBulkConversationAction({ userId, conversationIds, scope, action, ...options }) {
  const ids = normalizeIds(conversationIds);
  if (!ids.length) throw Object.assign(new Error('conversationIds required'), { statusCode: 400 });
  const results = [];
  for (const conversationId of ids) {
    results.push(await applyConversationAction({ userId, conversationId, scope, action, ...options }));
  }
  return {
    ok: true,
    action,
    scope,
    conversationIds: ids,
    affectedIds: results.flatMap(result => result.affectedIds),
    affectedCount: results.reduce((sum, result) => sum + result.affectedCount, 0),
  };
}
