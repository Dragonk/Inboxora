import { withTransaction } from './db.js';
import { resolveConversationAlias } from './conversationOverridePolicy.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';

async function resolveArchiveDestination(client, accountId, folderMappings) {
  const mapped = folderMappings?.archive;
  if (mapped) {
    const row = await client.query('SELECT path, special_use FROM folders WHERE account_id = $1 AND path = $2 AND no_select = false LIMIT 1', [accountId, mapped]);
    if (row.rows[0]) return row.rows[0];
  }
  const row = await client.query(`SELECT path, special_use FROM folders WHERE account_id = $1 AND no_select = false
    AND (special_use IN ('\\Archive','\\All') OR lower(name) LIKE '%archive%')
    ORDER BY CASE WHEN special_use = '\\Archive' THEN 0 WHEN lower(name) LIKE '%archive%' THEN 1 ELSE 2 END LIMIT 1`, [accountId]);
  return row.rows[0] || null;
}

async function resolveMoveDestination(client, accountId, targetFolder) {
  const result = await client.query(
    'SELECT path, special_use FROM folders WHERE account_id = $1 AND path = $2 AND no_select = false LIMIT 1',
    [accountId, targetFolder],
  );
  return result.rows[0] || null;
}

// CE actions must use the provider-aware IMAP move path when invoked from the
// application routes. The optional manager keeps the pure service tests and
// offline planning callers deterministic. The database row is updated only for
// confirmed IMAP moves; non-UIDPLUS moves are removed locally and re-synced so
// an unknown destination UID is never fabricated.
async function movePhysicalRowsWithProvider(client, rows, destinations, imapManager) {
  if (!imapManager) {
    // Pure service callers (unit/planning paths) retain the deterministic DB-only
    // behavior. Application routes always pass the ImapManager and therefore take
    // the provider-confirmed branch below.
    return { moved: rows.map(row => ({ ...row, newUid: row.uid })), resync: [] };
  }
  const moved = [];
  const resync = [];
  const groups = new Map();
  for (const row of rows) {
    const destination = destinations.get(row.id);
    if (!destination) continue;
    const key = `${row.account_id}\u0000${row.folder}\u0000${destination.path}`;
    if (!groups.has(key)) groups.set(key, { accountId: row.account_id, fromFolder: row.folder, destination: destination.path, rows: [] });
    groups.get(key).rows.push(row);
  }
  for (const group of groups.values()) {
    const accountResult = await client.query(
      'SELECT * FROM email_accounts WHERE id = $1',
      [group.accountId],
    );
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const result = await imapManager.bulkMoveMessages(account, group.rows.map(row => row.uid), group.fromFolder, group.destination);
    const succeeded = new Set((result.succeeded || []).map(String));
    for (const row of group.rows) {
      if (!succeeded.has(String(row.uid))) {
        throw Object.assign(new Error(`Provider move failed for copy ${row.id}`), { statusCode: 502 });
      }
      const newUid = result.uidMap?.get(Number(row.uid)) || null;
      if (newUid == null) {
        resync.push({ account, folder: group.destination });
      }
      moved.push({ ...row, destinationFolder: group.destination, newUid });
    }
  }
  return { moved, resync };
}

async function archiveRows(client, rows, userId, imapManager = null) {
  const destinations = new Map();
  const accountMappings = new Map();
  for (const row of rows) {
    if (!accountMappings.has(row.account_id)) {
      const account = await client.query(
        'SELECT folder_mappings FROM email_accounts WHERE id = $1 AND user_id = $2',
        [row.account_id, userId],
      );
      accountMappings.set(row.account_id, account.rows[0]?.folder_mappings || {});
    }
    const destination = await resolveArchiveDestination(client, row.account_id, accountMappings.get(row.account_id));
    if (!destination) throw Object.assign(new Error('No archive folder configured for account'), { statusCode: 409 });
    destinations.set(row.id, destination);
  }
  const providerResult = await movePhysicalRowsWithProvider(client, rows, destinations, imapManager);
  const changed = [];
  for (const row of providerResult.moved) {
    const destination = destinations.get(row.id);
    if (destination.special_use === '\\All') {
      const deleted = await client.query('DELETE FROM messages WHERE id = $1 RETURNING id, folder', [row.id]);
      changed.push(...deleted.rows.map(deletedRow => ({ ...row, ...deletedRow, destinationFolder: destination.path, special_use: destination.special_use })));
    } else if (row.newUid == null) {
      await client.query('DELETE FROM messages WHERE id = $1 RETURNING id, folder', [row.id]);
      changed.push({ ...row, id: row.id, folder: row.folder, destinationFolder: destination.path, special_use: destination.special_use, needsResync: true });
    } else {
      const updated = await client.query(
        'UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 RETURNING id, folder',
        [destination.path, row.newUid, row.id],
      );
      changed.push(...updated.rows.map(updatedRow => ({ ...updatedRow, destinationFolder: destination.path, special_use: destination.special_use })));
    }
  }
  for (const item of providerResult.resync) {
    imapManager?.syncFolderOnDemand(item.account, item.folder)?.catch(err => console.warn('CE archive resync failed:', err.message));
  }
  return { rows: changed, rowCount: changed.length };
}

export const COPY_SCOPES = new Set([
  'THIS_COPY',
  'ALL_COPIES_OF_LOGICAL_MESSAGE',
  'COPIES_ON_THIS_ACCOUNT',
  'WHOLE_CONVERSATION',
]);

function updateFolderCountsForAction(rows, action, imapManager, userId) {
  if (!imapManager || !rows.length || !['archive', 'move', 'delete'].includes(action)) return;
  const deltas = new Map();
  const add = (accountId, folder, total, unread) => {
    const key = `${accountId}:${folder}`;
    const current = deltas.get(key) || { accountId, folder, total: 0, unread: 0 };
    current.total += total;
    current.unread += unread;
    deltas.set(key, current);
  };
  for (const row of rows) {
    const unread = row.is_read ? 0 : 1;
    add(row.account_id, row.folder, -1, -unread);
    if (action === 'move' && row.destinationFolder && row.destinationFolder !== row.folder) {
      add(row.account_id, row.destinationFolder, 1, unread);
    }
    if (action === 'archive' && row.destinationFolder && row.destinationFolder !== row.folder && row.special_use !== '\\All') {
      add(row.account_id, row.destinationFolder, 1, unread);
    }
  }
  for (const delta of deltas.values()) {
    adjustFolderCounts(delta.accountId, delta.folder, delta.total, delta.unread);
    imapManager.broadcast?.({ type: 'folder_updated', folder: delta.folder, accountId: delta.accountId }, userId);
  }
}

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
    // Scope is account-local copies of the SELECTED logical message, not every
    // LogicalMessage in the conversation. This keeps the UI/API meaning aligned
    // with the explicit scope label and prevents unrelated replies from moving.
    values.push(selectedRow.account_id, selectedRow.logical_message_id || selectedRow.id);
    where = selectedRow.logical_message_id
      ? 'm.account_id = $2 AND m.logical_message_id = $3'
      : 'm.account_id = $2 AND m.id = $3';
  } else {
    values.push(canonicalConversationId);
    where = 'm.conversation_id = $2';
  }

  const affected = await client.query(
    `SELECT m.id, m.account_id, m.logical_message_id, m.conversation_id, m.folder, m.uid
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
  imapManager = null,
}) {
  if (!userId) throw Object.assign(new Error('userId is required'), { statusCode: 400 });
  if (!conversationId) throw Object.assign(new Error('conversationId is required'), { statusCode: 400 });
  assertScope(scope);
  if (!['archive', 'move', 'delete', 'read', 'star'].includes(action)) {
    throw Object.assign(new Error(`Unsupported conversation action: ${action}`), { statusCode: 400 });
  }
  if (action === 'move' && !targetFolder) {
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
      result = await archiveRows(client, resolved.rows, userId, imapManager);
    } else {
      const destinations = new Map();
      for (const row of resolved.rows) {
        const destination = await resolveMoveDestination(client, row.account_id, targetFolder);
        if (!destination) throw Object.assign(new Error(`Destination folder not found for account: ${targetFolder}`), { statusCode: 409 });
        destinations.set(row.id, destination);
      }
      const providerResult = await movePhysicalRowsWithProvider(client, resolved.rows, destinations, imapManager);
      result = { rows: [], rowCount: 0 };
      for (const row of providerResult.moved) {
        if (row.newUid == null) {
          await client.query('DELETE FROM messages WHERE id = $1', [row.id]);
          result.rows.push({ id: row.id, folder: targetFolder, needsResync: true });
          result.rowCount++;
        } else {
          const updated = await client.query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 RETURNING id, folder', [targetFolder, row.newUid, row.id]);
          result.rows.push(...updated.rows);
          result.rowCount += updated.rowCount || updated.rows.length;
        }
      }
      for (const item of providerResult.resync) imapManager?.syncFolderOnDemand(item.account, item.folder)?.catch(err => console.warn('CE move resync failed:', err.message));
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

    updateFolderCountsForAction(result.rows, action, imapManager, userId);
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

export async function applyBulkConversationAction({ userId, conversationIds, items = null, scope, action, ...options }) {
  const {
    imapManager = null,
  } = options;
  const normalizedItems = Array.isArray(items)
    ? items.filter(item => item && item.conversationId).map(item => ({
      conversationId: String(item.conversationId),
      copyId: item.copyId || null,
      logicalMessageId: item.logicalMessageId || null,
    }))
    : normalizeIds(conversationIds).map(conversationId => ({ conversationId, copyId: null, logicalMessageId: null }));
  if (!normalizedItems.length) throw Object.assign(new Error('conversationIds or items required'), { statusCode: 400 });
  assertScope(scope);
  if (scope !== 'WHOLE_CONVERSATION' && normalizedItems.some(item => !item.copyId && !item.logicalMessageId)) {
    throw Object.assign(new Error(`Bulk scope ${scope} requires copyId or logicalMessageId selectors`), { statusCode: 400 });
  }
  if (!['archive', 'move', 'delete', 'read', 'star'].includes(action)) {
    throw Object.assign(new Error(`Unsupported conversation action: ${action}`), { statusCode: 400 });
  }
  return withTransaction(async client => {
    const results = [];
    // Resolve/lock in deterministic conversation UUID order while retaining each
    // caller-selected physical/logical selector. This prevents a bulk action from
    // silently falling back to the globally latest copy.
    for (const item of [...normalizedItems].sort((a, b) => a.conversationId.localeCompare(b.conversationId))) {
      const resolved = await resolvePhysicalIds(client, {
        userId, conversationId: item.conversationId, scope,
        copyId: item.copyId || options.copyId,
        logicalMessageId: item.logicalMessageId || options.logicalMessageId,
      });
      const physicalIds = resolved.rows.map(row => row.id);
      let result;
      const previousRows = resolved.rows.map(row => ({ ...row }));
      if (action === 'read') result = await client.query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id', [!!options.isRead, physicalIds]);
      else if (action === 'star') result = await client.query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id', [!!options.isStarred, physicalIds]);
      else if (action === 'delete') result = await client.query('UPDATE messages SET is_deleted = true WHERE id = ANY($1::uuid[]) RETURNING id', [physicalIds]);
      else if (action === 'archive') result = await archiveRows(client, resolved.rows, userId, imapManager);
      else {
        if (!options.targetFolder) throw Object.assign(new Error('targetFolder required'), { statusCode: 400 });
        const destinations = new Map();
        for (const row of resolved.rows) {
          const destination = await resolveMoveDestination(client, row.account_id, options.targetFolder);
          if (!destination) throw Object.assign(new Error(`Destination folder not found for account: ${options.targetFolder}`), { statusCode: 409 });
          destinations.set(row.id, destination);
        }
        const providerResult = await movePhysicalRowsWithProvider(client, resolved.rows, destinations, imapManager);
        result = { rows: [], rowCount: 0 };
        for (const row of providerResult.moved) {
          if (row.newUid == null) {
            await client.query('DELETE FROM messages WHERE id = $1', [row.id]);
            result.rows.push({ id: row.id });
            result.rowCount++;
          } else {
            const updated = await client.query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 RETURNING id', [options.targetFolder, row.newUid, row.id]);
            result.rows.push(...updated.rows);
            result.rowCount += updated.rowCount || updated.rows.length;
          }
        }
        for (const item of providerResult.resync) imapManager?.syncFolderOnDemand(item.account, item.folder)?.catch(err => console.warn('CE bulk move resync failed:', err.message));
      }
      await client.query(`UPDATE conversations c SET logical_message_count = COALESCE((SELECT COUNT(DISTINCT m.logical_message_id) FROM messages m WHERE m.conversation_id = c.id AND NOT m.is_deleted),0), copy_count = COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND NOT m.is_deleted),0), unread_count = COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND NOT m.is_deleted AND NOT m.is_read),0), last_message_at = (SELECT MAX(m.date) FROM messages m WHERE m.conversation_id = c.id AND NOT m.is_deleted), updated_at = NOW() WHERE c.id = $1 AND c.user_id = $2`, [resolved.canonicalConversationId, userId]);
      updateFolderCountsForAction(result.rows.map(row => ({ ...previousRows.find(previous => previous.id === row.id), ...row })), action, imapManager, userId);
      results.push({ conversationId: resolved.canonicalConversationId, selectedCopyId: resolved.selected.id, affectedIds: result.rows.map(row => row.id), affectedCount: result.rowCount });
    }
    return { ok: true, action, scope, conversationIds: normalizedItems.map(item => item.conversationId), affectedIds: results.flatMap(result => result.affectedIds), affectedCount: results.reduce((sum, result) => sum + result.affectedCount, 0) };
  }, { serializable: true });
}
