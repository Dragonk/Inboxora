import { ownIdentityAddresses } from './conversationIngestEnvelope.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';
import { pool } from './db.js';
import { upsertConversationCopy } from './conversationPersistence.js';

const ALL_ACCOUNTS_SCOPE = '00000000-0000-0000-0000-000000000000';

function scopeId(accountId) {
  return accountId || ALL_ACCOUNTS_SCOPE;
}

function cursorPredicate(values, checkpoint) {
  if (!checkpoint?.last_message_id) return { sql: '', values };
  const next = [...values, checkpoint.last_sort_is_null, checkpoint.last_message_date, checkpoint.last_message_id];
  const base = next.length - 2;
  const predicate = checkpoint.last_sort_is_null
    ? `(m.date IS NULL AND m.id > $${next.length}::uuid)`
    : `((m.date IS NOT NULL AND (m.date > $${base + 1}::timestamptz OR (m.date = $${base + 1}::timestamptz AND m.id > $${next.length}::uuid))) OR m.date IS NULL)`;
  return {
    sql: `AND ${predicate}`,
    values: next,
  };
}

export async function rebuildConversationCopies({ userId, accountId = null, limit = 100, dryRun = true, force = false } = {}) {
  if (!userId) throw new Error('userId is required');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const scope = scopeId(accountId);
  const lockKey = `conversation-rebuild:${userId}:${scope}`;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const checkpointResult = await client.query('SELECT * FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2', [userId, scope]);
    const checkpoint = checkpointResult.rows[0] || null;
    if (!dryRun && checkpoint?.status === 'complete' && !force) return { scanned: 0, updated: 0, complete: true, next: null, dryRun: false };
    const effectiveCheckpoint = force ? null : checkpoint;
    const baseValues = accountId ? [userId, accountId] : [userId];
    const accountFilter = accountId ? 'AND m.account_id = $2' : '';
    const scoped = dryRun ? { sql: '', values: baseValues } : cursorPredicate(baseValues, effectiveCheckpoint);
    const limitParam = scoped.values.length + 1;
    const rows = await client.query(`
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
        const before = await client.query('SELECT conversation_id, logical_message_id, canonical_message_id, provider_thread_id, threading_reason, threading_confidence FROM messages WHERE id = $1', [row.id]);
        await upsertConversationCopy(row, {
          identities: ownIdentityAddresses(row),
          provider: providerIdentityForCopy(row),
        });
        const after = await client.query('SELECT conversation_id, logical_message_id, canonical_message_id, provider_thread_id, threading_reason, threading_confidence FROM messages WHERE id = $1', [row.id]);
        if (JSON.stringify(before.rows[0] || null) !== JSON.stringify(after.rows[0] || null)) updated++;
      }
    }

    const last = rows.rows.at(-1);
    const complete = rows.rows.length < safeLimit;
    if (!dryRun) {
      await client.query(`
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
      `, [userId, scope, last ? last.date === null : effectiveCheckpoint?.last_sort_is_null ?? null, last?.date || null, last?.id || null, complete ? 'complete' : 'paused', rows.rows.length, updated, JSON.stringify({ limit: safeLimit, complete, force })]);
    }

    return { scanned: rows.rows.length, updated, wouldChange: updated, changed: updated, complete, next: complete ? null : { date: last?.date || null, id: last?.id, isNull: last?.date === null }, dryRun, batches: 1, totalScanned: rows.rows.length, totalUpdated: updated };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    client.release();
  }
}
