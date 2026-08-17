import { query, withTransaction } from './db.js';
import { assertConversationOwner, refreshConversationAggregates } from './conversationOverridePolicy.js';

const OVERRIDE_TYPES = new Set(['force-include', 'force-exclude', 'manual-split', 'manual-merge', 'lock-conversation']);

export function validateOverrideType(value) {
  if (!OVERRIDE_TYPES.has(value)) throw new Error('Unsupported conversation override type');
  return value;
}

async function ownedConversation(client, userId, conversationId) {
  const result = await client.query('SELECT id, manually_locked FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [conversationId, userId]);
  if (!result.rows[0]) {
    const error = new Error('Conversation not found');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

export async function applyConversationOverride({ userId, conversationId, logicalMessageId = null, overrideType, targetId = null, reason = null }) {
  validateOverrideType(overrideType);
  return withTransaction(async client => {
    const conversation = await assertConversationOwner(client, userId, conversationId);
    if (logicalMessageId) {
      const message = await client.query('SELECT id FROM logical_messages WHERE id = $1 AND user_id = $2 AND conversation_id = $3 FOR UPDATE', [logicalMessageId, userId, conversationId]);
      if (!message.rows[0]) {
        const error = new Error('Logical message not found in conversation');
        error.statusCode = 404;
        throw error;
      }
    }
    if (overrideType === 'manual-merge') {
      if (!targetId || targetId === conversationId) throw new Error('manual-merge requires a different target conversation');
      await ownedConversation(client, userId, targetId);
      await client.query('INSERT INTO conversation_aliases (user_id, alias_conversation_id, canonical_conversation_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, alias_conversation_id) DO UPDATE SET canonical_conversation_id = EXCLUDED.canonical_conversation_id, reason = EXCLUDED.reason', [userId, conversationId, targetId, reason || 'manual-merge']);
      await client.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [targetId, conversationId]);
      await client.query('UPDATE logical_messages SET conversation_id = $1 WHERE conversation_id = $2', [targetId, conversationId]);
      await client.query('UPDATE conversation_evidence SET conversation_id = $1 WHERE conversation_id = $2', [targetId, conversationId]);
      await refreshConversationAggregates(client, userId, targetId);
      await refreshConversationAggregates(client, userId, conversationId);
    }
    if (overrideType === 'manual-split') {
      if (!logicalMessageId) throw new Error('manual-split requires logicalMessageId');
      const created = await client.query(`INSERT INTO conversations (user_id, kind, subject_snapshot, canonical_subject, first_message_at, last_message_at, segment_number) SELECT user_id, 'manual_conversation', subject_snapshot, canonical_subject, first_message_at, last_message_at, segment_number + 1 FROM conversations WHERE id = $1 RETURNING id`, [conversationId]);
      const newConversationId = created.rows[0].id;
      await client.query('UPDATE logical_messages SET conversation_id = $1, parent_logical_message_id = NULL WHERE id = $2 AND user_id = $3', [newConversationId, logicalMessageId, userId]);
      await client.query('UPDATE messages SET conversation_id = $1 WHERE logical_message_id = $2', [newConversationId, logicalMessageId]);
      await refreshConversationAggregates(client, userId, conversationId);
      await refreshConversationAggregates(client, userId, newConversationId);
      targetId = newConversationId;
    }
    if (overrideType === 'lock-conversation') await client.query('UPDATE conversations SET manually_locked = true, updated_at = NOW() WHERE id = $1', [conversationId]);
    await client.query('INSERT INTO conversation_overrides (user_id, conversation_id, logical_message_id, override_type, target_id, reason) VALUES ($1,$2,$3,$4,$5,$6)', [userId, conversationId, logicalMessageId, overrideType, targetId, reason]);
    return { conversationId, overrideType, targetId, manuallyLocked: overrideType === 'lock-conversation' || conversation.manually_locked };
  }, { serializable: true });
}

export async function listConversationOverrides({ userId, conversationId }) {
  const result = await query('SELECT * FROM conversation_overrides WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at DESC', [userId, conversationId]);
  return result.rows;
}
