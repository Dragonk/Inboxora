import { readStorageRetentionPolicy } from './storageRetentionSettings.js';
import { expireMailBodyCache, BODY_CACHE_RETENTION_BATCH } from './mailBodyCacheRetention.js';
import type { PoolClient } from 'pg';
import { pool, query } from './db.js';
import { HEADER_REPAIR_SCAN_LIMIT, repairConversationHeadersWithClient, type HeaderRepairStage } from './conversationHeaderRepair.js';
import { conversationSerializeKey } from './conversationPersistence.js';
import { toAppError } from '../utils/errors.js';

const WORKER_LOCK = 167160146;
export const DAV_RETENTION_DAYS = 30;
export const DAV_MAX_CHANGES = 10_000;
const BATCH_SIZE = 500;
const RETIRED = ['calendar_sync_changes_legacy_0146', 'contact_sync_changes_legacy_0146'] as const;

interface Progress extends Record<string, unknown> {
  cursor?: string | null;
  repaired?: number;
  logical_bytes_saved?: number;
  skipped_in_sweep?: number;
  scan_rows?: number;
}

async function transaction<T>(client: PoolClient, action: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '250ms'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const value = await action();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function save(client: PoolClient, task: string, progress: Progress, done: boolean, delaySeconds = 0): Promise<void> {
  await client.query(`INSERT INTO storage_maintenance(task, progress, completed_at, next_run_at)
    VALUES ($1, $2::jsonb, CASE WHEN $3 THEN NOW() ELSE NULL END, NOW() + $4 * INTERVAL '1 second')
    ON CONFLICT(task) DO UPDATE SET progress = EXCLUDED.progress,
      completed_at = EXCLUDED.completed_at, next_run_at = EXCLUDED.next_run_at, updated_at = NOW()`,
  [task, JSON.stringify(progress), done, delaySeconds]);
}

async function deferTask(client: PoolClient, task: string, progress: Progress, error: unknown, delaySeconds = 300): Promise<void> {
  const code = toAppError(error).code ?? 'MAINTENANCE_FAILED';
  await save(client, task, { ...progress, last_error_code: code }, false, delaySeconds);
  console.warn('[storage-maintenance] task deferred:', task, code);
}

/** These two journals were retired atomically with a DAV token floor advance in
 * 0146. TRUNCATE releases their heap/TOAST/index files without copying GB of data.
 * Never truncate a current journal or a canonical event/contact/message table. */
export async function releaseRetiredDavJournals(client: PoolClient): Promise<number> {
  let released = 0;
  for (const table of RETIRED) {
    const task = `retired:${table}`;
    const previous = await client.query<{ progress: Progress; deferred: boolean; completed_at: string | null }>(
      'SELECT progress, completed_at, next_run_at > NOW() AS deferred FROM storage_maintenance WHERE task = $1', [task]);
    if (previous.rows[0]?.completed_at || previous.rows[0]?.deferred) continue;
    try {
      await transaction(client, async () => {
        const before = await client.query<{ bytes: string }>('SELECT pg_total_relation_size($1::regclass) AS bytes', [table]);
        await client.query(`TRUNCATE TABLE ${table}`); // fixed allowlist, no CASCADE
        const after = await client.query<{ bytes: string }>('SELECT pg_total_relation_size($1::regclass) AS bytes', [table]);
        const freed = Math.max(0, Number(before.rows[0].bytes) - Number(after.rows[0].bytes));
        await save(client, task, { before_bytes: before.rows[0].bytes, after_bytes: after.rows[0].bytes, released_bytes: freed }, true);
        released += freed;
      });
    } catch (error) {
      await deferTask(client, task, previous.rows[0]?.progress ?? {}, error);
    }
  }
  return released;
}

/** Retention and floor advance commit together. One row is the latest state of
 * a URL, not a history of payloads; older clients must resync when it is retired. */
export async function pruneDavJournal(client: PoolClient, kind: 'calendar' | 'contacts', id: string): Promise<number> {
  const calendar = kind === 'calendar';
  const parent = calendar ? 'calendars' : 'address_books';
  const table = calendar ? 'calendar_sync_changes' : 'contact_sync_changes';
  const scope = calendar ? 'calendar_id' : 'address_book_id';
  return transaction(client, async () => {
    const policy = await readStorageRetentionPolicy(client);
    const owner = await client.query(`SELECT id FROM ${parent} WHERE id = $1 FOR UPDATE`, [id]);
    if (!owner.rows.length) return 0;
    const cutoff = await client.query<{ cutoff: string | null }>(`SELECT MAX(version)::text AS cutoff FROM (
      SELECT version FROM ${table} WHERE ${scope} = $1 AND created_at < NOW() - $3 * INTERVAL '1 day'
      UNION ALL
      (SELECT version FROM ${table} WHERE ${scope} = $1 ORDER BY version DESC OFFSET $2 LIMIT 1)
    ) candidates`, [id, policy.dav_history_max_entries, policy.dav_history_days]);
    const version = cutoff.rows[0].cutoff;
    if (version === null) return 0;
    const removed = await client.query<{ version: string }>(`DELETE FROM ${table} WHERE (${scope}, version) IN (
      SELECT ${scope}, version FROM ${table} WHERE ${scope} = $1 AND version <= $2::bigint
       ORDER BY version LIMIT $3
    ) RETURNING version::text`, [id, version, BATCH_SIZE]);
    if (removed.rows.length) {
      // Versions are bigint; never round them through JavaScript Number.
      const floor = removed.rows.reduce((maximum, row) => BigInt(row.version) > maximum ? BigInt(row.version) : maximum, 0n);
      await client.query(`UPDATE ${parent} SET sync_min_version = GREATEST(sync_min_version, $2::bigint) WHERE id = $1`, [id, floor.toString()]);
    }
    return removed.rowCount ?? 0;
  });
}

async function repairOneAccount(client: PoolClient): Promise<boolean> {
  const due = await client.query<{ id: string; user_id: string; progress: Progress | null }>(`
    SELECT a.id, a.user_id, s.progress FROM email_accounts a
    LEFT JOIN storage_maintenance s ON s.task = 'headers:' || a.id::text
    WHERE s.task IS NULL OR (s.completed_at IS NULL AND s.next_run_at <= NOW())
    ORDER BY s.updated_at ASC NULLS FIRST, a.id LIMIT 1`);
  const account = due.rows[0];
  if (!account) return false;
  const key = conversationSerializeKey(account.user_id, account.id);
  const acquired = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked', [key, key + ':2']);
  if (!acquired.rows[0].locked) {
    await save(client, `headers:${account.id}`, account.progress ?? {}, false, 5);
    return true;
  }
  let stage: HeaderRepairStage = 'scan';
  try {
    await transaction(client, async () => {
      const prior = account.progress ?? {};
      const stats = await repairConversationHeadersWithClient(client, {
        userId: account.user_id, accountId: account.id, apply: true, limit: HEADER_REPAIR_SCAN_LIMIT,
        afterId: typeof prior.cursor === 'string' ? prior.cursor : null,
        onStage: value => { stage = value; },
      });
      const repaired = (prior.repaired ?? 0) + stats.repaired;
      const saved = (prior.logical_bytes_saved ?? 0) + stats.beforeBytes - stats.afterBytes;
      await save(client, `headers:${account.id}`, {
        repaired, logical_bytes_saved: saved, cursor: stats.next,
        scan_rows: (prior.scan_rows ?? 0) + stats.scanned,
        skipped_last_batch: stats.skipped, scanned_last_batch: stats.scanned,
        skipped_in_sweep: (prior.cursor ? prior.skipped_in_sweep ?? 0 : 0) + stats.skipped,
      }, stats.next === null, 0);
      if (stats.repaired) {
        await client.query(`INSERT INTO storage_maintenance(task, progress, completed_at, next_run_at, updated_at)
          VALUES ('vacuum:messages', '{"needed":true}', NULL, NOW(), NOW())
          ON CONFLICT(task) DO UPDATE SET
            progress = storage_maintenance.progress || '{"needed":true}'::jsonb,
            completed_at = NULL,
            next_run_at = NOW(),
            updated_at = NOW()`);
      }
      if (stats.repaired && (repaired % 1000 === 0 || stats.next === null)) {
        console.info('[storage-maintenance] header progress', JSON.stringify({ repaired, logical_bytes_saved: saved }));
      }
    });
  } catch (error) {
    // The failed transaction rolled back data and checkpoint together. Keep the
    // old cursor and counters, but let other accounts and retention make progress.
    await deferTask(client, `headers:${account.id}`, { ...account.progress, last_error_stage: stage }, error);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [key, key + ':2']);
  }
  return true;
}

async function retainOneCollection(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ id: string; kind: 'calendar' | 'contacts'; task: string; progress: Progress | null }>(`
    SELECT scopes.*, s.progress FROM (
      SELECT id, 'calendar' AS kind, 'dav:calendar:' || id::text AS task FROM calendars
      UNION ALL SELECT id, 'contacts', 'dav:contacts:' || id::text FROM address_books
    ) scopes LEFT JOIN storage_maintenance s ON s.task = scopes.task
    WHERE s.task IS NULL OR s.next_run_at <= NOW()
    ORDER BY s.updated_at ASC NULLS FIRST, scopes.task LIMIT 1`);
  const collection = result.rows[0];
  if (!collection) return false;
  try {
    const removed = await pruneDavJournal(client, collection.kind, collection.id);
    await save(client, collection.task, { removed_last_batch: removed }, removed < BATCH_SIZE, removed < BATCH_SIZE ? 3600 : 0);
  } catch (error) {
    await deferTask(client, collection.task, collection.progress ?? {}, error);
  }
  return true;
}

/** Operational histories only. Do not delete idempotency receipts, unresolved
 * writes, sync cursors, tombstone candidates or spam-training examples. */
export async function pruneOperationalHistory(client: PoolClient): Promise<number> {
  let changed = 0;
  const policy = await readStorageRetentionPolicy(client);
  const rules = [
    ['auth_events', 'created_at', '', policy.auth_log_days],
    ['conversation_rebuild_audit', 'created_at', '', policy.conversation_audit_days],
    ['conversation_ingest_failures', 'resolved_at', 'resolved_at IS NOT NULL AND', policy.resolved_ingest_error_days],
  ] as const;
  for (const [table, column, extra, days] of rules) {
    const result = await client.query(`DELETE FROM ${table} WHERE id IN (
      SELECT id FROM ${table} WHERE ${extra} ${column} < NOW() - $2 * INTERVAL '1 day'
      ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
    )`, [BATCH_SIZE,days]);
    changed += result.rowCount ?? 0;
  }
  const outbox = await client.query(`UPDATE domain_outbox SET payload = '{}'::jsonb, last_error = NULL
    WHERE id IN (SELECT id FROM domain_outbox WHERE status = 'done'
      AND updated_at < NOW() - $2 * INTERVAL '1 day' AND (payload <> '{}'::jsonb OR last_error IS NOT NULL)
      ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED)`, [BATCH_SIZE,policy.completed_outbox_payload_days]);
  changed += outbox.rowCount ?? 0;
  return changed;
}

export async function readStorageMaintenanceStatus() {
  const current = await query<{ database_bytes: string; messages_bytes: string; calendar_journal_bytes: string; contact_journal_bytes: string }>(`
    SELECT pg_database_size(current_database())::text AS database_bytes,
      pg_total_relation_size('messages')::text AS messages_bytes,
      pg_total_relation_size('calendar_sync_changes')::text AS calendar_journal_bytes,
      pg_total_relation_size('contact_sync_changes')::text AS contact_journal_bytes`);
  const tasks = await query<{ task: string; progress: Progress; completed_at: string | null; updated_at: string; next_run_at: string }>(
    'SELECT task, progress, completed_at, updated_at, next_run_at FROM storage_maintenance ORDER BY task');
  return { current: current.rows[0], tasks: tasks.rows };
}

async function runDueOperationalRetention(client: PoolClient): Promise<number> {
  const due = await client.query("SELECT 1 FROM storage_maintenance WHERE task = 'logs' AND next_run_at > NOW()");
  if (due.rows.length) return 0;
  try {
    const changed = await pruneOperationalHistory(client);
    await save(client, 'logs', { changed_last_batch: changed }, changed === 0, changed ? 0 : 3600);
    return changed;
  } catch (error) {
    await deferTask(client, 'logs', {}, error);
    return 0;
  }
}

async function runBodyCacheRetention(client: PoolClient): Promise<boolean> {
  const previous = await client.query<{ progress: Progress; deferred: boolean }>(
    "SELECT progress,next_run_at>NOW() AS deferred FROM storage_maintenance WHERE task='body-cache'");
  if (previous.rows[0]?.deferred) return false;
  try {
    return await transaction(client, async () => {
      const result = await expireMailBodyCache(client);
      const prior = previous.rows[0]?.progress ?? {};
      await save(client, 'body-cache', { evicted: Number(prior.evicted ?? 0) + result.evicted,
        logical_bytes_saved: Number(prior.logical_bytes_saved ?? 0) + result.logicalBytes,
        evicted_last_batch: result.evicted }, result.evicted < BODY_CACHE_RETENTION_BATCH,
        result.evicted < BODY_CACHE_RETENTION_BATCH ? 3600 : 0);
      // Autovacuum handles ordinary cache eviction; do not force one VACUUM per
      // hundred evictions or mix this periodic task with initial repair completion.
      return result.evicted === BODY_CACHE_RETENTION_BATCH;
    });
  } catch (error) {
    await deferTask(client, 'body-cache', previous.rows[0]?.progress ?? {}, error);
    return false;
  }
}

/** VACUUM is not a short OLTP statement. Give it a generous, finite budget and
 * back off after cancellation/lock contention; never retry every minute forever. */
export async function vacuumRepairedMessages(client: PoolClient): Promise<boolean> {
  try {
    await client.query("SET vacuum_cost_delay = '2ms'");
    await client.query("SET maintenance_work_mem = '16MB'");
    await client.query("SET statement_timeout = '10min'");
    await client.query('VACUUM (ANALYZE, PARALLEL 0) messages');
    await save(client, 'vacuum:messages', { needed: false }, true, 86400);
    return true;
  } catch (error) {
    await deferTask(client, 'vacuum:messages', { needed: true }, error, 3600);
    return false;
  } finally {
    await client.query("SET statement_timeout = '15s'");
  }
}

/** Pausing data repair must not disable privacy/security-log retention. */
export async function runOperationalRetentionPass(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK]);
    if (!lock.rows[0].locked) return false;
    await client.query("SET statement_timeout = '15s'");
    await client.query("SET lock_timeout = '250ms'");
    return (await runDueOperationalRetention(client)) > 0;
  } finally { client.release(true); }
}

/** One bounded pass; PostgreSQL owns single-flight across processes and restarts. */
export async function runStorageMaintenancePass(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK]);
    if (!lock.rows[0].locked) return false;
    await client.query("SET statement_timeout = '15s'");
    await client.query("SET lock_timeout = '250ms'");
    const released = await releaseRetiredDavJournals(client);
    if (released) console.info('[storage-maintenance] retired DAV journal files released', JSON.stringify({ released_bytes: released }));
    const headers = await repairOneAccount(client);
    const journals = await retainOneCollection(client);
    const logs = await runDueOperationalRetention(client);
    const cache = await runBodyCacheRetention(client);
    // Normal VACUUM only: never automatically take a long exclusive lock on mail.
    // Retired journals already released real files above. Repaired header space
    // becomes reusable; physical message-file reduction is measured, not promised.
    if (!headers) {
      const vacuum = await client.query("SELECT 1 FROM storage_maintenance WHERE task = 'vacuum:messages' AND progress->>'needed' = 'true' AND next_run_at <= NOW()");
      if (vacuum.rows.length) {
        await vacuumRepairedMessages(client);
      }
    }
    if (!headers && !journals && logs === 0) {
      await client.query(`UPDATE storage_maintenance SET progress = progress || jsonb_build_object(
        'database_after_bytes', pg_database_size(current_database())::text,
        'measured_after_at', clock_timestamp()), completed_at = NOW(), updated_at = NOW()
        WHERE task = 'baseline' AND completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM email_accounts a
            LEFT JOIN storage_maintenance h ON h.task = 'headers:' || a.id::text
            WHERE h.task IS NULL OR h.completed_at IS NULL)
          AND (SELECT COUNT(*) FROM storage_maintenance WHERE task IN
            ('retired:calendar_sync_changes_legacy_0146', 'retired:contact_sync_changes_legacy_0146')
            AND completed_at IS NOT NULL) = 2
          AND NOT EXISTS (SELECT 1 FROM storage_maintenance WHERE task = 'vacuum:messages' AND progress->>'needed' = 'true')`);
    }
    return headers || journals || logs > 0 || cache;
  } finally {
    // Dedicated maintenance session is discarded: no advisory locks, altered
    // timeouts or aborted transaction can leak into an application request.
    client.release(true);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let current: Promise<unknown> | undefined;
let generation = 0;
export function startStorageMaintenance(env: NodeJS.ProcessEnv = process.env): void {
  const own = ++generation;
  if (timer) clearTimeout(timer);
  if (env.NODE_ENV === 'test') return;
  const repairEnabled = env.STORAGE_MAINTENANCE_ENABLED !== 'false';
  const tick = async () => {
    if (own !== generation) return;
    let delay = 60_000;
    try {
      current = repairEnabled ? runStorageMaintenancePass() : runOperationalRetentionPass();
      if (await current) delay = 1000;
    } catch (error) {
      console.warn('[storage-maintenance] deferred; next pass will retry:', toAppError(error).message);
    } finally {
      if (own === generation) { timer = setTimeout(() => { void tick(); }, delay); timer.unref(); }
    }
  };
  timer = setTimeout(() => { void tick(); }, 10_000);
  timer.unref();
}
export async function stopStorageMaintenance(): Promise<void> {
  generation++;
  if (timer) clearTimeout(timer);
  try { await current; } catch { /* the tick reports the failure and the DB rolls back */ }
}
