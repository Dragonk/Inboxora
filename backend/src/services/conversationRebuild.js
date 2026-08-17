import { providerIdentityForCopy } from './conversationProviderEnvelope.js';
import { query } from './db.js';
import { upsertConversationCopy } from './conversationPersistence.js';

const ALL_ACCOUNTS_SCOPE = '00000000-0000-0000-0000-000000000000';

function scopeId(accountId) {
  return accountId || ALL_ACCOUNTS_SCOPE;
}

function cursorPredicate(values, checkpoint) {
  if (!checkpoint?.last_sort_is_null || checkpoint.last_sort_is_null === false) {
    if (!checkpoint?.last_message_id) return { sql: '', values };
  }
  const next = [...values, checkpoint.last_sort_is_null, checkpoint.last_message_date, checkpoint.last_message_id];
  return { sql: `AND ((m.date IS NULL), m.date, m.id) > ($${next.length - 2}::boolean, $${next.length - 1}::timestamptz, $${next.length}::uuid)`, values: next };
}

export async function rebuildConversationCopies({ userId, accountId = null, limit = 100, dryRun = true } = {}) {
  if (!userId) throw new Error('userId is required');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const scope = scopeId(accountId);
  const checkpointResult = await query('SELECT * FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2', [userId, scope]);
  const checkpoint = checkpointResult.rows[0] || null;
  const baseValues = accountId ? [userId, accountId] : [userId];
  const accountFilter = accountId ? 'AND m.account_id = $2' : '';
  const scoped = dryRun ? { sql: '', values: baseValues } : cursorPredicate(baseValues, checkpoint);
  const limitParam = scoped.values.length + 1;
  const rows = await query(`
    SELECT m.*, a.user_id, a.email_address
      FROM messages m
      JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
     WHERE m.is_deleted = false ${accountFilter} ${scoped.sql}
     ORDER BY (m.date IS NULL), m.date ASC, m.id ASC
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
  if (!dryRun) {
    await query(`
      INSERT INTO conversation_rebuild_checkpoints
        (user_id, scope_account_id, last_sort_is_null, last_message_date, last_message_id, status, dry_run, scanned_count, updated_count, diagnostics)
      VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9::jsonb)
      ON CONFLICT (user_id, scope_account_id) DO UPDATE SET
        last_sort_is_null = EXCLUDED.last_sort_is_null,
        last_message_date = EXCLUDED.last_message_date,
        last_message_id = EXCLUDED.last_message_id,
        status = EXCLUDED.status,
        scanned_count = conversation_rebuild_checkpoints.scanned_count + EXCLUDED.scanned_count,
        updated_count = conversation_rebuild_checkpoints.updated_count + EXCLUDED.updated_count,
        diagnostics = EXCLUDED.diagnostics,
        updated_at = NOW()
    `, [userId, scope, last ? last.date === null : checkpoint?.last_sort_is_null ?? null, last?.date || null, last?.id || null, complete ? 'complete' : 'paused', rows.rows.length, updated, JSON.stringify({ limit: safeLimit, complete })]);
  }

  return { scanned: rows.rows.length, updated, complete, next: complete ? null : { date: last?.date || null, id: last?.id, isNull: last?.date === null }, dryRun };
}
