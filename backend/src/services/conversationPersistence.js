import { createHash } from 'crypto';
import { withTransaction } from './db.js';
import { canonicalConversationSubject, classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';

function fingerprintCopy(copy) {
  return createHash('sha256').update(JSON.stringify([
    copy.body_text || '', copy.subject || '', copy.from_email || '', copy.date || '', copy.in_reply_to || '', copy.thread_references || '',
  ])).digest('hex');
}

export async function hydrateLogicalMessage(copy, { identities = [] } = {}) {
  const owner = copy.user_id || copy.userId;
  const identity = logicalMessageIdentity(copy, { userId: owner });
  const canonicalSubject = canonicalConversationSubject(copy.subject);
  return {
    ...identity,
    userId: owner,
    accountId: copy.account_id,
    rawInReplyTo: copy.in_reply_to || null,
    rawReferences: copy.thread_references || null,
    canonicalSubject,
    direction: classifyDirection(copy, identities),
    messageDate: copy.date || null,
    bodyFingerprint: createHash('sha256').update(String(copy.body_text || '')).digest('hex'),
    headerFingerprint: createHash('sha256').update(JSON.stringify([copy.message_id, copy.in_reply_to, copy.thread_references])).digest('hex'),
    copyFingerprint: fingerprintCopy(copy),
  };
}

export async function upsertConversationCopy(copy, { identities = [], provider = null, parent = null } = {}) {
  return withTransaction(async client => {
    const verified = await client.query(`
      SELECT m.*, a.user_id
        FROM messages m
        JOIN email_accounts a ON a.id = m.account_id
       WHERE m.id = $1 AND a.user_id IS NOT NULL
       FOR UPDATE`, [copy.id]);
    if (verified.rows.length !== 1) throw new Error('Conversation copy not found or owner mismatch');
    const source = { ...verified.rows[0], user_id: verified.rows[0].user_id };
    const hydrated = await hydrateLogicalMessage(source, { identities });
    const decision = threadingDecision({ message: source, parent, provider, identities });

    let logical;
    if (hydrated.canonicalMessageId) {
      const existing = await client.query(`
        SELECT id, conversation_id, message_id_collision_key
          FROM logical_messages
         WHERE user_id = $1 AND canonical_message_id = $2 AND message_id_collision_key = $3
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`, [hydrated.userId, hydrated.canonicalMessageId, hydrated.collisionKey]);
      logical = existing.rows[0];
    }
    if (!logical) {
      logical = (await client.query(`
        INSERT INTO logical_messages (
          user_id, canonical_message_id, raw_message_id, message_id_collision_key,
          raw_in_reply_to, raw_references, subject, canonical_subject, direction,
          message_date, body_fingerprint, header_fingerprint, threading_reason, threading_confidence
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id, conversation_id`, [hydrated.userId, hydrated.canonicalMessageId, hydrated.rawMessageId, hydrated.collisionKey,
        hydrated.rawInReplyTo, hydrated.rawReferences, source.subject || null, hydrated.canonicalSubject,
        hydrated.direction, hydrated.messageDate, hydrated.bodyFingerprint, hydrated.headerFingerprint,
        decision.reason, decision.confidence])).rows[0];
    } else {
      await client.query(`UPDATE logical_messages SET updated_at = NOW(), threading_reason = $2, threading_confidence = $3 WHERE id = $1`, [logical.id, decision.reason, decision.confidence]);
    }

    let conversationId = logical.conversation_id;
    if (!conversationId && parent?.logicalMessageId) {
      const parentRow = await client.query(`SELECT conversation_id FROM logical_messages WHERE id = $1 AND user_id = $2 FOR UPDATE`, [parent.logicalMessageId, hydrated.userId]);
      conversationId = parentRow.rows[0]?.conversation_id || null;
      if (conversationId) await client.query('UPDATE logical_messages SET parent_logical_message_id = $1 WHERE id = $2', [parent.logicalMessageId, logical.id]);
    }
    if (!conversationId) {
      conversationId = (await client.query(`
        INSERT INTO conversations (
          user_id, kind, subject_snapshot, canonical_subject, first_message_at,
          last_message_at, logical_message_count, copy_count, threading_confidence
        ) VALUES ($1,$2,$3,$4,$5,$5,0,0,$6)
        RETURNING id`, [hydrated.userId, decision.kind, source.subject || null, hydrated.canonicalSubject, hydrated.messageDate, decision.confidence])).rows[0].id;
      await client.query('UPDATE logical_messages SET conversation_id = $1 WHERE id = $2', [conversationId, logical.id]);
    }

    const attached = await client.query(`
      UPDATE messages
         SET logical_message_id = $1, conversation_id = $2, canonical_message_id = $3,
             threading_reason = $4, threading_confidence = $5,
             threading_algorithm_version = 'conversation-v2', row_version = row_version + 1
       WHERE id = $6
       RETURNING id`, [logical.id, conversationId, hydrated.canonicalMessageId, decision.reason, decision.confidence, source.id]);
    if (attached.rowCount !== 1) throw new Error('Conversation copy attachment failed');

    await client.query(`
      UPDATE conversations c
         SET first_message_at = (SELECT MIN(message_date) FROM logical_messages WHERE conversation_id = c.id),
             last_message_at = (SELECT MAX(message_date) FROM logical_messages WHERE conversation_id = c.id),
             logical_message_count = (SELECT COUNT(*) FROM logical_messages WHERE conversation_id = c.id),
             copy_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false),
             unread_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = false AND is_read = false),
             updated_at = NOW()
       WHERE c.id = $1`, [conversationId]);
    return { logicalMessageId: logical.id, conversationId, kind: decision.kind, canonicalSubject: hydrated.canonicalSubject };
  });
}
