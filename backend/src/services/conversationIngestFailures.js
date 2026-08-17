import { withTransaction } from './db.js';

export async function recordConversationIngestFailure({ userId, accountId = null, messageRowId = null, operation, error, diagnostics = {} }) {
  if (!userId || !operation || !error) return;
  await withTransaction(async client => {
    await client.query(`
      INSERT INTO conversation_ingest_failures (user_id, account_id, message_row_id, operation, error_code, error_message, diagnostics)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [userId, accountId, messageRowId, operation, error.code || null, String(error.message || error), JSON.stringify(diagnostics)]);
  });
}

export async function claimConversationIngestFailures({ userId = null, limit = 50 } = {}) {
  const values = [];
  const where = ['resolved_at IS NULL', 'next_attempt_at <= NOW()'];
  if (userId) { values.push(userId); where.push(`user_id = $${values.length}`); }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
  return withTransaction(async client => {
    const result = await client.query(`
      SELECT * FROM conversation_ingest_failures
       WHERE ${where.join(' AND ')}
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $${values.length}
       FOR UPDATE SKIP LOCKED`, values);
    for (const row of result.rows) await client.query(`UPDATE conversation_ingest_failures SET attempts = attempts + 1, next_attempt_at = NOW() + INTERVAL '5 minutes', updated_at = NOW() WHERE id = $1`, [row.id]);
    return result.rows;
  });
}

export async function resolveConversationIngestFailure(id) {
  return withTransaction(async client => client.query('UPDATE conversation_ingest_failures SET resolved_at = NOW(), updated_at = NOW() WHERE id = $1', [id]));
}
