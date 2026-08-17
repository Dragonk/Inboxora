import { query } from './db.js';

export async function effectiveConversationOverride(client, { userId, conversationId, logicalMessageId = null }) {
  const result = await client.query(`
    SELECT override_type, target_id, reason
      FROM conversation_overrides
     WHERE user_id = $1
       AND (conversation_id = $2 OR logical_message_id = $3)
     ORDER BY created_at DESC, id DESC
  `, [userId, conversationId, logicalMessageId]);
  const latest = new Map();
  for (const row of result.rows) if (!latest.has(row.override_type)) latest.set(row.override_type, row);
  return {
    locked: latest.has('lock-conversation'),
    forceInclude: latest.get('force-include') || null,
    forceExclude: latest.get('force-exclude') || null,
    split: latest.get('manual-split') || null,
    merge: latest.get('manual-merge') || null,
  };
}

export async function resolveConversationAlias(client, { userId, conversationId }) {
  let current = conversationId;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    if (seen.has(current)) throw new Error('Conversation alias cycle detected');
    seen.add(current);
    const result = await client.query('SELECT canonical_conversation_id FROM conversation_aliases WHERE user_id = $1 AND alias_conversation_id = $2', [userId, current]);
    if (!result.rows[0] || result.rows[0].canonical_conversation_id === current) return current;
    current = result.rows[0].canonical_conversation_id;
  }
  throw new Error('Conversation alias chain too deep');
}

export async function refreshConversationAggregates(client, userId, conversationId) {
  await client.query(`
    UPDATE conversations c SET
      first_message_at = (SELECT MIN(message_date) FROM logical_messages WHERE conversation_id = c.id),
      last_message_at = (SELECT MAX(message_date) FROM logical_messages WHERE conversation_id = c.id),
      logical_message_count = (SELECT COUNT(*) FROM logical_messages WHERE conversation_id = c.id),
      copy_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false),
      unread_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false AND is_read = false),
      updated_at = NOW()
    WHERE c.id = $1 AND c.user_id = $2
  `, [conversationId, userId]);
}

export async function lockConversationsDeterministically(client, userId, ids) {
  const ordered = [...new Set(ids.filter(Boolean))].sort();
  if (ordered.length) await client.query('SELECT id FROM conversations WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [userId, ordered]);
  return ordered;
}

export async function assertConversationOwner(client, userId, conversationId) {
  const result = await client.query('SELECT id, user_id, manually_locked FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [conversationId, userId]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.statusCode = 404; throw error; }
  return result.rows[0];
}

export async function conversationOverrideSummary(userId, conversationId) {
  const result = await query('SELECT * FROM conversation_overrides WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at DESC', [userId, conversationId]);
  return result.rows;
}
