import { resolveOwnIdentityAddresses } from './conversationIngestEnvelope.js';
import { providerIdentityForCopy } from './conversationProviderEnvelope.js';
import { pool } from './db.js';
import { _upsertConversationCopyWithClient } from './conversationPersistence.js';

const ALL_ACCOUNTS_SCOPE = '00000000-0000-0000-0000-000000000000';

function scopeId(accountId) {
  return accountId || ALL_ACCOUNTS_SCOPE;
}

function cursorPredicate(values, checkpoint) {
  if (!checkpoint?.last_message_id && !checkpoint?.id) return { sql: '', values };
  const lastIsNull = checkpoint.last_sort_is_null ?? checkpoint.isNull ?? false;
  const lastDate = checkpoint.last_message_date ?? checkpoint.date ?? null;
  const lastId = checkpoint.last_message_id ?? checkpoint.id;
  // Cast parameter types explicitly so PostgreSQL can infer them even when
  // the value is NULL (otherwise 'could not determine data type of parameter $N').
  const next = [...values, lastIsNull, lastDate, lastId];
  const base = next.length - 2;
  const predicate = lastIsNull
    ? `(m.date IS NULL AND m.id > $${next.length}::uuid)`
    : `((m.date IS NOT NULL AND (m.date > $${base + 1}::timestamptz OR (m.date = $${base + 1}::timestamptz AND m.id > $${next.length}::uuid))) OR m.date IS NULL)`;
  return {
    sql: `AND ${predicate}`,
    values: next,
  };
}

/**
 * Snapshot the CE-relevant columns of a message row so we can compare the
 * proposed state (after upsertConversationCopy) against the current state.
 * Returns a plain object that JSON-compares deterministically.
 */
const CE_SNAPSHOT_COLS = 'conversation_id, logical_message_id, canonical_message_id, provider_message_id, provider_thread_id, threading_reason, threading_confidence, threading_algorithm_version';

async function snapshotMessage(client, messageRow) {
  const r = await client.query(
    `SELECT ${CE_SNAPSHOT_COLS} FROM messages WHERE id = $1`,
    [messageRow.id],
  );
  return r.rows[0] || null;
}

function ceSnapshotChanged(before, after) {
  if (!before && !after) return false;
  if (!before || !after) return true;
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Faithful dry-run: run the EXACT same decision + persistence path as a write,
 * but inside a transaction that is ALWAYS rolled back. Zero persistent writes,
 * zero side effects, but the wouldChange count reflects real conversation/logical/
 * provider/parent state changes — not just "missing IDs".
 *
 * This fixes P1-01: the old dry-run counted only !conversation_id ||
 * !logical_message_id || threading_algorithm_version !== 'conversation-v2',
 * which gave wouldChange=0 for records that were historically over-merged but
 * still carry complete CE IDs.
 */
async function dryRunBatch(client, rows) {
  let wouldChange = 0;
  for (const row of rows) {
    const before = await snapshotMessage(client, row);
    try {
      await _upsertConversationCopyWithClient(client, row, {
        identities: await resolveOwnIdentityAddresses(client, row.account_id, row),
        provider: providerIdentityForCopy(row),
      });
    } catch {
      // If upsert throws (e.g. constraint violation in dry-run), the row
      // WOULD change — the write path would need to handle it. Count as change.
      wouldChange++;
      continue;
    }
    const after = await snapshotMessage(client, row);
    if (ceSnapshotChanged(before, after)) wouldChange++;
  }
  return wouldChange;
}

export async function rebuildConversationCopies({ userId, accountId = null, limit = 100, dryRun = true, force = false, cursor = null } = {}) {
  if (!userId) throw new Error('userId is required');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const scope = scopeId(accountId);
  // P2-04: Use two-int32 advisory lock key to avoid int32 hash collision.
  // hashtext returns int32 (collision risk); using (hashtext, hashtextextended)
  // as two separate int32s gives a 64-bit key with negligible collision risk.
  const lockKey = `conversation-rebuild:${userId}:${scope}`;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [lockKey, lockKey + ':2']);
    const result = await client.query(`SELECT * FROM conversation_rebuild_checkpoints WHERE user_id = $1 AND scope_account_id = $2`, [userId, scope]);
    const checkpoint = result.rows[0] || null;
    if (!dryRun && checkpoint?.status === 'complete' && !force && !cursor) return { scanned: 0, updated: 0, wouldChange: 0, complete: true, next: null, dryRun: false };
    const effectiveCheckpoint = cursor || (force ? null : checkpoint);
    const baseValues = accountId ? [userId, accountId] : [userId];
    const accountFilter = accountId ? 'AND m.account_id = $2' : '';
    const scoped = cursorPredicate(baseValues, effectiveCheckpoint);
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
    let wouldChange = 0;

    if (dryRun) {
      // Faithful dry-run: run upsertConversationCopy in a savepoint that is
      // ALWAYS rolled back. The wouldChange count reflects real CE state
      // changes (conversation_id, logical_message_id, provider IDs,
      // threading_reason, threading_confidence, threading_algorithm_version)
      // computed by the EXACT same decision path as a write.
      await client.query('BEGIN');
      try {
        wouldChange = await dryRunBatch(client, rows.rows);
      } finally {
        await client.query('ROLLBACK');
      }
    }

    if (!dryRun) {
      // P0 fix: wrap the entire write batch + checkpoint in an explicit serializable
      // transaction so a crash mid-batch cannot leave partially committed messages
      // with a stale checkpoint. The advisory lock prevents concurrent rebuilds;
      // the transaction ensures atomicity of the batch + checkpoint.
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        for (const row of rows.rows) {
          const before = await snapshotMessage(client, row);
          await _upsertConversationCopyWithClient(client, row, {
            identities: await resolveOwnIdentityAddresses(client, row.account_id, row),
            provider: providerIdentityForCopy(row),
          });
          const after = await snapshotMessage(client, row);
          if (ceSnapshotChanged(before, after)) updated++;
        }

        const last = rows.rows.at(-1);
        const complete = rows.rows.length < safeLimit;
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
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } else {
      // dryRun path: no writes, no checkpoint
    }

    const last = rows.rows.at(-1);
    const complete = rows.rows.length < safeLimit;

    return { scanned: rows.rows.length, updated, wouldChange: dryRun ? wouldChange : updated, changed: updated, complete, next: complete ? null : { date: last?.date || null, id: last?.id, isNull: last?.date === null }, dryRun, batches: 1, totalScanned: rows.rows.length, totalUpdated: updated };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [lockKey, lockKey + ':2']).catch(() => {});
    client.release();
  }
}
