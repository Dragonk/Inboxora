import { query } from '../db.js';
import { normalizeMessageId, normalizeMessageIdList } from './normalizeMessageId.js';

export async function findThreadParents(accountId, messageIds) {
  const ids = [...new Set(messageIds.map(normalizeMessageId).filter(Boolean))];
  if (!accountId || !ids.length) return new Map();
  const result = await query(
    `SELECT message_id, thread_id
       FROM messages
      WHERE account_id = $1
        AND message_id = ANY($2::text[])
        AND thread_id IS NOT NULL`,
    [accountId, ids]
  );
  return new Map(result.rows.map(row => [row.message_id, row.thread_id]));
}

export async function findSubjectThread(accountId, messageId, normalized) {
  if (!accountId || !normalized) return null;
  const result = await query(
    `SELECT thread_id
       FROM messages
      WHERE account_id = $1
        AND is_deleted = false
        AND message_id IS DISTINCT FROM $2
        AND thread_id IS NOT NULL
        AND normalized_subject = $3
        AND date > NOW() - INTERVAL '90 days'
      ORDER BY date ASC
      LIMIT 1`,
    [accountId, messageId, normalized]
  );
  return result.rows[0]?.thread_id || null;
}

export async function resolveThreadId({ accountId, messageId, inReplyTo, references, subject, normalizeSubject }) {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) return null;

  const referencesList = normalizeMessageIdList(references);
  const replyTo = normalizeMessageId(inReplyTo);
  const candidates = [...new Set([
    ...referencesList,
    ...(replyTo ? [replyTo] : []),
  ])];

  if (candidates.length) {
    const found = await findThreadParents(accountId, candidates);
    // RFC References is ordered oldest-to-newest. Prefer the oldest known root,
    // then the newest known ancestor when the root is not present locally.
    for (const candidate of candidates) {
      if (found.has(candidate)) return found.get(candidate);
    }
    return candidates[0];
  }

  const normalized = normalizeSubject(subject);
  return (await findSubjectThread(accountId, normalizedMessageId, normalized)) || normalizedMessageId;
}
