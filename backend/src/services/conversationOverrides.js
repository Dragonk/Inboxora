import { pool, withTransaction } from './db.js';
import { assertConversationOwner, assertNoAliasCycle, lockConversationsDeterministically, refreshConversationAggregates, resolveConversationAlias } from './conversationOverridePolicy.js';

const OVERRIDE_TYPES = new Set(['force-include', 'force-exclude', 'manual-split', 'manual-merge', 'lock-conversation', 'unlock-conversation', 'manual-move']);

export function validateOverrideType(value) {
  if (!OVERRIDE_TYPES.has(value)) throw new Error('Unsupported conversation override type');
  return value;
}

export async function applyConversationOverride({ userId, conversationId, logicalMessageId = null, scope = 'message-only', overrideType, targetId = null, reason = null }) {
  validateOverrideType(overrideType);
  return withTransaction(async client => {
    const canonicalConversationId = await resolveConversationAlias(client, { userId, conversationId });
    const conversation = overrideType === 'manual-merge' ? null : await assertConversationOwner(client, userId, canonicalConversationId);
    conversationId = canonicalConversationId;
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
      const sourceCanonical = await resolveConversationAlias(client, { userId, conversationId });
      const targetCanonical = await resolveConversationAlias(client, { userId, conversationId: targetId });
      if (sourceCanonical === targetCanonical) throw new Error('manual-merge would create an alias cycle');
      await lockConversationsDeterministically(client, userId, [sourceCanonical, targetCanonical]);
      await assertConversationOwner(client, userId, sourceCanonical);
      await assertConversationOwner(client, userId, targetCanonical);
      await assertNoAliasCycle(client, { userId, sourceConversationId: sourceCanonical, targetConversationId: targetCanonical });
      await client.query('INSERT INTO conversation_aliases (user_id, alias_conversation_id, canonical_conversation_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, alias_conversation_id) DO UPDATE SET canonical_conversation_id = EXCLUDED.canonical_conversation_id, reason = EXCLUDED.reason', [userId, sourceCanonical, targetCanonical, reason || 'manual-merge']);
      await client.query('UPDATE messages SET conversation_id = $1, conversation_user_id = $2 WHERE conversation_id = $3 AND conversation_user_id = $2', [targetCanonical, userId, sourceCanonical]);
      await client.query('UPDATE logical_messages SET conversation_id = $1 WHERE conversation_id = $2 AND user_id = $3', [targetCanonical, sourceCanonical, userId]);
      await client.query('UPDATE conversation_evidence SET conversation_id = $1 WHERE conversation_id = $2 AND user_id = $3', [targetCanonical, sourceCanonical, userId]);
      await client.query('UPDATE provider_thread_mappings SET conversation_id = $1, last_seen_at = NOW() WHERE conversation_id = $2 AND user_id = $3', [targetCanonical, sourceCanonical, userId]);
      await client.query('UPDATE conversation_overrides SET conversation_id = $1 WHERE conversation_id = $2 AND user_id = $3', [targetCanonical, sourceCanonical, userId]);
      await client.query('UPDATE conversations SET continued_to_conversation_id = $1 WHERE id = $2 AND user_id = $3', [targetCanonical, sourceCanonical, userId]);
      await client.query('UPDATE conversations SET continued_from_conversation_id = $1 WHERE id = $2 AND user_id = $3', [sourceCanonical, targetCanonical, userId]);
      await refreshConversationAggregates(client, userId, targetCanonical);
      await refreshConversationAggregates(client, userId, sourceCanonical);
      targetId = targetCanonical;
    }
    if (overrideType === 'manual-split') {
      if (!logicalMessageId) throw new Error('manual-split requires logicalMessageId');
      if (!['message-only', 'message-with-descendants'].includes(scope)) throw new Error('Unsupported manual-split scope');
      const created = await client.query(`INSERT INTO conversations (user_id, kind, subject_snapshot, canonical_subject, first_message_at, last_message_at, segment_number) SELECT user_id, 'manual_conversation', subject_snapshot, canonical_subject, first_message_at, last_message_at, segment_number + 1 FROM conversations WHERE id = $1 RETURNING id`, [conversationId]);
      const newConversationId = created.rows[0].id;
      const scopeFilter = scope === 'message-with-descendants' ? `WITH RECURSIVE descendants(id, path) AS (
        SELECT id, ARRAY[id] FROM logical_messages WHERE id = $2 AND user_id = $3
        UNION ALL
        SELECT lm.id, d.path || lm.id FROM logical_messages lm JOIN descendants d ON lm.parent_logical_message_id = d.id
         WHERE lm.user_id = $3 AND NOT lm.id = ANY(d.path)
      ) UPDATE logical_messages lm SET conversation_id = $1,
        parent_logical_message_id = CASE WHEN lm.id = $2 THEN NULL ELSE lm.parent_logical_message_id END
       WHERE lm.id IN (SELECT id FROM descendants)` :
      'UPDATE logical_messages SET conversation_id = $1, parent_logical_message_id = NULL WHERE id = $2 AND user_id = $3';
      await client.query(scopeFilter, [newConversationId, logicalMessageId, userId]);
      await client.query('UPDATE messages SET conversation_id = $1, conversation_user_id = $2 WHERE logical_message_id IN (SELECT id FROM logical_messages WHERE conversation_id = $1) AND conversation_user_id = $2', [newConversationId, userId]);
      await client.query('UPDATE conversation_evidence SET conversation_id = $1 WHERE logical_message_id IN (SELECT id FROM logical_messages WHERE conversation_id = $1) AND user_id = $2', [newConversationId, userId]);
      await client.query('UPDATE conversation_overrides SET conversation_id = $1, target_id = CASE WHEN target_id = $3 THEN $1 ELSE target_id END WHERE logical_message_id IN (SELECT id FROM logical_messages WHERE conversation_id = $1) AND user_id = $2', [newConversationId, userId, conversationId]);
      await client.query(`UPDATE logical_messages child SET parent_logical_message_id = NULL
        WHERE child.user_id = $1 AND child.conversation_id <> $2
          AND child.parent_logical_message_id IN (SELECT id FROM logical_messages WHERE conversation_id = $2)`, [userId, newConversationId]);
      const crossEdge = await client.query(`SELECT 1 FROM logical_messages child JOIN logical_messages parent ON parent.id = child.parent_logical_message_id
        WHERE child.user_id = $1 AND (child.conversation_id IS DISTINCT FROM parent.conversation_id) LIMIT 1`, [userId]);
      if (crossEdge.rows.length) throw new Error('conversation split left a cross-conversation parent edge');
      await refreshConversationAggregates(client, userId, conversationId);
      await refreshConversationAggregates(client, userId, newConversationId);
      targetId = newConversationId;
    }
    if (overrideType === 'manual-move') {
      if (!logicalMessageId) throw new Error('manual-move requires logicalMessageId');
      if (!targetId || targetId === conversationId) throw new Error('manual-move requires a different target conversation');
      const targetCanonical = await resolveConversationAlias(client, { userId, conversationId: targetId });
      if (targetCanonical === conversationId) throw new Error('manual-move target is the same conversation (alias)');
      await assertConversationOwner(client, userId, targetCanonical);
      const component = await client.query(`WITH RECURSIVE descendants(id, path) AS (
        SELECT id, ARRAY[id] FROM logical_messages WHERE id = $1 AND user_id = $2 AND conversation_id = $3
        UNION ALL
        SELECT lm.id, d.path || lm.id FROM logical_messages lm JOIN descendants d ON lm.parent_logical_message_id = d.id
         WHERE lm.user_id = $2 AND NOT lm.id = ANY(d.path)
      ) SELECT lm.id FROM logical_messages lm JOIN descendants d ON d.id = lm.id`, [logicalMessageId, userId, conversationId]);
      const movedIds = component.rows.map(r => r.id);
      await client.query('UPDATE logical_messages SET conversation_id = $1, parent_logical_message_id = CASE WHEN id = $2 THEN NULL ELSE parent_logical_message_id END WHERE id = ANY($3::uuid[]) AND user_id = $4', [targetCanonical, logicalMessageId, movedIds, userId]);
      await client.query('UPDATE messages SET conversation_id = $1, conversation_user_id = $2 WHERE logical_message_id = ANY($3::uuid[]) AND conversation_user_id = $2', [targetCanonical, userId, movedIds]);
      await client.query('UPDATE conversation_evidence SET conversation_id = $1 WHERE logical_message_id = ANY($2::uuid[]) AND user_id = $3', [targetCanonical, movedIds, userId]);
      await client.query(`UPDATE logical_messages child SET parent_logical_message_id = NULL WHERE child.user_id = $1 AND child.conversation_id <> $2 AND child.parent_logical_message_id IN (SELECT id FROM logical_messages WHERE conversation_id = $2)`, [userId, targetCanonical]);
      const crossEdge = await client.query(`SELECT 1 FROM logical_messages child JOIN logical_messages parent ON parent.id = child.parent_logical_message_id WHERE child.user_id = $1 AND child.conversation_id IS DISTINCT FROM parent.conversation_id LIMIT 1`, [userId]);
      if (crossEdge.rows.length) throw new Error('manual-move left a cross-conversation parent edge');
      await refreshConversationAggregates(client, userId, conversationId);
      await refreshConversationAggregates(client, userId, targetCanonical);
      targetId = targetCanonical;
    }
    if (overrideType === 'lock-conversation') await client.query('UPDATE conversations SET manually_locked = true, updated_at = NOW() WHERE id = $1', [conversationId]);
    if (overrideType === 'unlock-conversation') await client.query('UPDATE conversations SET manually_locked = false, updated_at = NOW() WHERE id = $1', [conversationId]);
    await client.query('INSERT INTO conversation_overrides (user_id, conversation_id, logical_message_id, override_type, target_id, reason) VALUES ($1,$2,$3,$4,$5,$6)', [userId, conversationId, logicalMessageId, overrideType, targetId, reason]);
    return { conversationId, overrideType, targetId, manuallyLocked: overrideType === 'lock-conversation' || Boolean(conversation?.manually_locked) };
  }, { serializable: true });
}

export async function listConversationOverrides({ userId, conversationId }) {
  const client = await pool.connect();
  try {
    const canonicalId = await resolveConversationAlias(client, { userId, conversationId });
    const result = await client.query(
      'SELECT * FROM conversation_overrides WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at DESC',
      [userId, canonicalId],
    );
    return result.rows;
  } finally {
    client.release();
  }
}
