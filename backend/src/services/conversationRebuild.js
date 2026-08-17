import { providerIdentityForCopy } from './conversationProviderEnvelope.js';
import { query } from './db.js';
import { upsertConversationCopy } from './conversationPersistence.js';

function cursorPredicate(values, checkpoint) {
  if (!checkpoint?.last_message_date || !checkpoint?.last_message_id) return { sql: '', values };
  const next = [...values, checkpoint.last_message_date, checkpoint.last_message_id];
  return { sql: `AND (m.date, m.id) > ($${next.length - 1}::timestamptz, $${next.length}::uuid)`, values: next };
}

export async function rebuildConversationCopies({ userId, accountId = null, limit = 100, dryRun = true } = {}) {
  if (!userId) throw new Error('userId is required');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const checkpointResult = await query('SELECT * FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND account_id IS NOT DISTINCT FROM $2', [userId, accountId]);
  const checkpoint = checkpointResult.rows[0] || null;
  const baseValues = [userId];
  const accountFilter = accountId ? 'AND m.account_id = $2' : '';
  const values = accountId ? [userId, accountId] : baseValues;
  const scoped = cursorPredicate(values, checkpoint);
  const limitParam = scoped.values.length + 1;
  const rows = await query(`
    SELECT m.*, a.user_id, a.email_address
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
     WHERE m.is_deleted = false ${accountFilter} ${scoped.sql}
     ORDER BY m.date ASC NULLS LAST, m.id ASC
     LIMIT $${limitParam}
  `, [...scoped.values, safeLimit]);

  let updated = 0;
  if (!dryRun) {
    for (const row of rows.rows) {
      await upsertConversationCopy(row, {
        identities: [row.email_address].filter(Boolean),
        provider: providerIdentityForCopy(row),
      });
      updated++;
    }
  }

  const last = rows.rows.at(-1);
  const complete = rows.rows.length < safeLimit;
  await query(`
    INSERT INTO conversation_rebuild_checkpoints
      (user_id, account_id, last_message_date, last_message_id, status, dry_run, scanned_count, updated_count, diagnostics)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    ON CONFLICT (user_id, account_id) DO UPDATE SET
      last_message_date = EXCLUDED.last_message_date,
      last_message_id = EXCLUDED.last_message_id,
      status = EXCLUDED.status,
      dry_run = EXCLUDED.dry_run,
      scanned_count = conversation_rebuild_checkpoints.scanned_count + EXCLUDED.scanned_count,
      updated_count = conversation_rebuild_checkpoints.updated_count + EXCLUDED.updated_count,
      diagnostics = EXCLUDED.diagnostics,
      updated_at = NOW()
  `, [userId, accountId, last?.date || checkpoint?.last_message_date || null, last?.id || checkpoint?.last_message_id || null, complete ? 'complete' : 'paused', dryRun, rows.rows.length, updated, JSON.stringify({ limit: safeLimit, complete })]);

  return { scanned: rows.rows.length, updated, complete, next: complete ? null : { date: last?.date, id: last?.id }, dryRun };
}
