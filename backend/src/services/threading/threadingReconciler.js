import { query, withTransaction } from '../db.js';
import { normalizeMessageId } from './normalizeMessageId.js';

const DEFAULT_BATCH_SIZE = 500;

export async function auditThreading({ accountId = null, limit = DEFAULT_BATCH_SIZE } = {}) {
  const values = [];
  const where = ['m.message_id IS NOT NULL'];
  if (accountId) {
    values.push(accountId);
    where.push(`m.account_id = $${values.length}`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_BATCH_SIZE, 1), 5000);
  values.push(safeLimit);
  const result = await query(`
    SELECT m.id, m.account_id, m.message_id, m.thread_id, m.in_reply_to,
           m.thread_references, m.normalized_subject
      FROM messages m
     WHERE ${where.join(' AND ')}
     ORDER BY m.account_id, m.date ASC NULLS FIRST, m.id
     LIMIT $${values.length}
  `, values);

  const findings = [];
  for (const row of result.rows) {
    const messageId = normalizeMessageId(row.message_id);
    const threadId = normalizeMessageId(row.thread_id);
    if (messageId && row.message_id !== messageId) {
      findings.push({ type: 'non_canonical_message_id', id: row.id, accountId: row.account_id, value: messageId });
    }
    if (row.thread_id && threadId && row.thread_id !== threadId) {
      findings.push({ type: 'non_canonical_thread_id', id: row.id, accountId: row.account_id, value: threadId });
    }
  }
  return { scanned: result.rows.length, findings, truncated: result.rows.length === safeLimit };
}

export async function rebuildThreading({ accountId = null, limit = DEFAULT_BATCH_SIZE, dryRun = true } = {}) {
  const audit = await auditThreading({ accountId, limit });
  if (dryRun || !audit.findings.length) return { ...audit, updated: 0, dryRun };

  const byId = new Map();
  for (const finding of audit.findings) {
    const current = byId.get(finding.id) || {};
    if (finding.type === 'non_canonical_message_id') current.messageId = finding.value;
    if (finding.type === 'non_canonical_thread_id') current.threadId = finding.value;
    byId.set(finding.id, current);
  }

  let updated = 0;
  await withTransaction(async client => {
    for (const [id, values] of byId) {
      const result = await client.query(`
        UPDATE messages
           SET message_id = COALESCE($1, message_id),
               thread_id = COALESCE($2, thread_id)
         WHERE id = $3
      `, [values.messageId || null, values.threadId || null, id]);
      updated += result.rowCount;
    }
  });
  return { ...audit, updated, dryRun };
}
