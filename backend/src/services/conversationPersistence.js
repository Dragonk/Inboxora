import { createHash } from 'crypto';
import { query, withTransaction } from './db.js';
import { canonicalConversationSubject, classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';

export async function hydrateLogicalMessage(copy, { identities = [] } = {}) {
  const owner = copy.user_id || copy.userId;
  const identity = logicalMessageIdentity(copy, { userId: owner, accountId: copy.account_id });
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
  };
}

export async function upsertConversationCopy(copy, { identities = [] } = {}) {
  const hydrated = await hydrateLogicalMessage(copy, { identities });
  return withTransaction(async client => {
    const existing = await client.query(
      `SELECT id, conversation_id, message_id_collision_key
         FROM logical_messages
        WHERE user_id = $1 AND canonical_message_id = $2
        ORDER BY created_at ASC
        LIMIT 2`,
      [hydrated.userId, hydrated.canonicalMessageId]
    );
    const collision = existing.rows.length > 1 || (existing.rows[0] && existing.rows[0].message_id_collision_key !== hydrated.collisionKey);
    const logical = collision || !existing.rows[0]
      ? (await client.query(`
          INSERT INTO logical_messages (
            user_id, canonical_message_id, raw_message_id, message_id_collision_key,
            raw_in_reply_to, raw_references, subject, canonical_subject, direction,
            message_date, body_fingerprint, header_fingerprint
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id`, [hydrated.userId, hydrated.canonicalMessageId, hydrated.rawMessageId, hydrated.collisionKey,
          hydrated.rawInReplyTo, hydrated.rawReferences, copy.subject || null, hydrated.canonicalSubject,
          hydrated.direction, hydrated.messageDate, hydrated.bodyFingerprint, hydrated.headerFingerprint])).rows[0]
      : existing.rows[0];
    await client.query(`
      UPDATE messages
         SET logical_message_id = $1,
             canonical_message_id = $2,
             row_version = row_version + 1
       WHERE id = $3
         AND account_id IN (SELECT id FROM email_accounts WHERE user_id = $4)`,
      [logical.id, hydrated.canonicalMessageId, copy.id, hydrated.userId]);
    return { logicalMessageId: logical.id, collision, canonicalSubject: hydrated.canonicalSubject };
  });
}
