import { query } from './db.js';

// P1-01: Override scoping — CONVERSATION-LEVEL vs MESSAGE-LEVEL.
// Conversation-level overrides: lock-conversation, unlock-conversation, manual-merge.
//   These apply to the whole conversation and are keyed by conversation_id.
// Message-level overrides: force-include, force-exclude, manual-split, manual-move.
//   These apply ONLY to a specific logical_message_id and are keyed by both
//   conversation_id AND logical_message_id.
// The old query `conversation_id = X OR logical_message_id = Y` was wrong because
// a message-level override for L1 could be picked up when querying for L2 in the
// same conversation. Now we query message-level overrides ONLY by their exact
// logical_message_id, and conversation-level overrides ONLY by conversation_id.
export async function effectiveConversationOverride(client, { userId, accountId, conversationId, logicalMessageId = null }) {
  // Conversation-level overrides (lock/unlock/merge) — keyed by conversation_id only.
  const conversationResult = await client.query(`
    SELECT id, override_type, target_id, reason, logical_message_id, created_at
      FROM conversation_overrides
     WHERE user_id = $1 AND account_id = $3
       AND conversation_id = $2
       AND logical_message_id IS NULL
     ORDER BY created_at DESC, id DESC
  `, [userId, conversationId, accountId]);
  const conversationLatest = new Map();
  for (const row of conversationResult.rows) {
    if (!conversationLatest.has(row.override_type)) conversationLatest.set(row.override_type, row);
  }

  // Message-level overrides (force-include/exclude/split/move) — keyed by logical_message_id.
  // Only returned if logicalMessageId is provided.
  let messageLatest = new Map();
  if (logicalMessageId) {
    const messageResult = await client.query(`
      SELECT id, override_type, target_id, reason, logical_message_id, created_at
        FROM conversation_overrides
       WHERE user_id = $1 AND account_id = $3
         AND logical_message_id = $2
         ORDER BY created_at DESC, id DESC
    `, [userId, logicalMessageId, accountId]);
    for (const row of messageResult.rows) {
      if (!messageLatest.has(row.override_type)) messageLatest.set(row.override_type, row);
    }
  }

  // P1-02: Lock/unlock event semantics — the latest event wins.
  // Query the latest lock-conversation OR unlock-conversation event.
  // If the latest event is lock → locked=true.
  // If the latest event is unlock → locked=false.
  // If no lock/unlock event exists → use the conversation's manually_locked column.
  let locked = null;
  const lockEvent = conversationLatest.get('lock-conversation');
  const unlockEvent = conversationLatest.get('unlock-conversation');
  if (lockEvent && !unlockEvent) {
    locked = true;
  } else if (unlockEvent && !lockEvent) {
    locked = false;
  } else if (lockEvent && unlockEvent) {
    // Both exist — compare created_at (the query above already orders by created_at DESC, id DESC).
    // The first one encountered in the ordered result is the latest.
    // Since we iterate in order and set conversationLatest, the last set wins the Map entry,
    // but we need to compare which is newer.
    const allEvents = conversationResult.rows.filter(r => r.override_type === 'lock-conversation' || r.override_type === 'unlock-conversation');
    const latestEvent = allEvents[0]; // first in DESC order
    locked = latestEvent.override_type === 'lock-conversation';
  }

  // A later force-include supersedes an earlier force-exclude (and vice versa).
  // Keep one authoritative manual membership event instead of treating the
  // existence of either historical event as permanent state.
  const membershipEvents = [...messageLatest.values()]
    .filter(row => row.override_type === 'force-include' || row.override_type === 'force-exclude')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id || '').localeCompare(String(a.id || '')));
  const latestMembership = membershipEvents[0] || null;

  return {
    locked,
    forceInclude: latestMembership?.override_type === 'force-include' ? latestMembership : null,
    forceExclude: latestMembership?.override_type === 'force-exclude' ? latestMembership : null,
    split: messageLatest.get('manual-split') || null,
    move: messageLatest.get('manual-move') || null,
    merge: conversationLatest.get('manual-merge') || null,
  };
}

export async function resolveConversationAlias(client, { userId, accountId = null, conversationId }) {
  let current = conversationId;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    if (seen.has(current)) throw new Error('Conversation alias cycle detected');
    seen.add(current);
    const result = await client.query('SELECT canonical_conversation_id FROM conversation_aliases WHERE user_id = $1 AND alias_conversation_id = $2 AND ($3::uuid IS NULL OR account_id = $3)', [userId, current, accountId]);
    if (!result.rows[0] || result.rows[0].canonical_conversation_id === current) return current;
    current = result.rows[0].canonical_conversation_id;
  }
  throw new Error('Conversation alias chain too deep');
}

export async function assertNoAliasCycle(client, { userId, accountId, sourceConversationId, targetConversationId }) {
  let current = targetConversationId;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    if (current === sourceConversationId) throw new Error('manual-merge would create an alias cycle');
    if (seen.has(current)) throw new Error('Conversation alias cycle detected');
    seen.add(current);
    const result = await client.query(
      'SELECT canonical_conversation_id FROM conversation_aliases WHERE user_id = $1 AND account_id = $3 AND alias_conversation_id = $2 FOR UPDATE',
      [userId, current, accountId],
    );
    const next = result.rows[0]?.canonical_conversation_id;
    if (!next || next === current) return;
    current = next;
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
      unread_count = (SELECT COUNT(*) FROM logical_messages lm WHERE lm.conversation_id = c.id AND EXISTS (SELECT 1 FROM messages m WHERE m.logical_message_id = lm.id AND m.conversation_id = c.id AND m.is_deleted = false AND m.is_read = false)),
      updated_at = NOW()
    WHERE c.id = $1 AND c.user_id = $2
  `, [conversationId, userId]);
}

// P1-05: Deterministic lock order — sort UUIDs lexicographically to prevent deadlocks.
// P2-04: Use a text-based sort (not int32 hash) to avoid collision risk.
export async function lockConversationsDeterministically(client, userId, ids) {
  const ordered = [...new Set(ids.filter(Boolean))].sort(); // lexicographic sort of UUID strings
  if (ordered.length) await client.query('SELECT id FROM conversations WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [userId, ordered]);
  return ordered;
}

export async function assertConversationOwner(client, userId, conversationId, accountId = null) {
  const result = await client.query('SELECT id, user_id, manually_locked FROM conversations WHERE id = $1 AND user_id = $2 AND ($3::uuid IS NULL OR account_id = $3) FOR UPDATE', [conversationId, userId, accountId]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.statusCode = 404; throw error; }
  return result.rows[0];
}

export async function conversationOverrideSummary(userId, conversationId) {
  const result = await query('SELECT * FROM conversation_overrides WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at DESC', [userId, conversationId]);
  return result.rows;
}
