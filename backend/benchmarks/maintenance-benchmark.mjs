import { performance } from 'node:perf_hooks';

// Simulate DB pool client
class MockPoolClient {
  constructor() {
    this.queries = [];
    this.rowCount = 10;
  }
  async query(text, params) {
    this.queries.push({ text, params });
    // Add artificial delay to simulate DB I/O (N+1 query impact)
    await new Promise(r => setTimeout(r, 2));
    if (text.includes('readStorageRetentionPolicy')) {
      return { rows: [{ auth_log_days: 30, conversation_audit_days: 90, resolved_ingest_error_days: 7, completed_outbox_payload_days: 1 }] };
    }
    return { rowCount: this.rowCount, rows: [{ changed: 40 }] }; // Mock for single query
  }
}

// Inline version of readStorageRetentionPolicy to match what's needed
async function readStorageRetentionPolicy(client) {
  return { auth_log_days: 30, conversation_audit_days: 90, resolved_ingest_error_days: 7, completed_outbox_payload_days: 1 };
}

// Copy of current implementation
async function pruneOperationalHistoryCurrent(client) {
  let changed = 0;
  const policy = await readStorageRetentionPolicy(client);
  const rules = [
    ['auth_events', 'created_at', '', policy.auth_log_days],
    ['conversation_rebuild_audit', 'created_at', '', policy.conversation_audit_days],
    ['conversation_ingest_failures', 'resolved_at', 'resolved_at IS NOT NULL AND', policy.resolved_ingest_error_days],
  ];
  const BATCH_SIZE = 5000;
  for (const [table, column, extra, days] of rules) {
    const result = await client.query(`DELETE FROM ${table} WHERE id IN (
      SELECT id FROM ${table} WHERE ${extra} ${column} < NOW() - $2 * INTERVAL '1 day'
      ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
    )`, [BATCH_SIZE, days]);
    changed += result.rowCount ?? 0;
  }
  const outbox = await client.query(`UPDATE domain_outbox SET payload = '{}'::jsonb, last_error = NULL
    WHERE id IN (SELECT id FROM domain_outbox WHERE status = 'done'
      AND updated_at < NOW() - $2 * INTERVAL '1 day' AND (payload <> '{}'::jsonb OR last_error IS NOT NULL)
      ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED)`, [BATCH_SIZE, policy.completed_outbox_payload_days]);
  changed += outbox.rowCount ?? 0;
  return changed;
}

// Copy of optimized implementation (CTE single query)
async function pruneOperationalHistoryOptimized(client) {
  const policy = await readStorageRetentionPolicy(client);
  const BATCH_SIZE = 5000;
  const result = await client.query(`
    WITH deleted_auth AS (
      DELETE FROM auth_events WHERE id IN (
        SELECT id FROM auth_events WHERE created_at < NOW() - $1 * INTERVAL '1 day'
        ORDER BY created_at LIMIT $5 FOR UPDATE SKIP LOCKED
      ) RETURNING 1
    ), deleted_audit AS (
      DELETE FROM conversation_rebuild_audit WHERE id IN (
        SELECT id FROM conversation_rebuild_audit WHERE created_at < NOW() - $2 * INTERVAL '1 day'
        ORDER BY created_at LIMIT $5 FOR UPDATE SKIP LOCKED
      ) RETURNING 1
    ), deleted_ingest AS (
      DELETE FROM conversation_ingest_failures WHERE id IN (
        SELECT id FROM conversation_ingest_failures WHERE resolved_at IS NOT NULL AND resolved_at < NOW() - $3 * INTERVAL '1 day'
        ORDER BY created_at LIMIT $5 FOR UPDATE SKIP LOCKED
      ) RETURNING 1
    ), updated_outbox AS (
      UPDATE domain_outbox SET payload = '{}'::jsonb, last_error = NULL
      WHERE id IN (SELECT id FROM domain_outbox WHERE status = 'done'
        AND updated_at < NOW() - $4 * INTERVAL '1 day' AND (payload <> '{}'::jsonb OR last_error IS NOT NULL)
        ORDER BY updated_at LIMIT $5 FOR UPDATE SKIP LOCKED)
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM deleted_auth) +
      (SELECT count(*) FROM deleted_audit) +
      (SELECT count(*) FROM deleted_ingest) +
      (SELECT count(*) FROM updated_outbox) AS changed
  `, [
    policy.auth_log_days,
    policy.conversation_audit_days,
    policy.resolved_ingest_error_days,
    policy.completed_outbox_payload_days,
    BATCH_SIZE
  ]);

  return Number(result.rows[0].changed) || 0;
}

async function runBenchmark() {
  const reps = 100;

  // Baseline
  let start = performance.now();
  for (let i = 0; i < reps; i++) {
    const client = new MockPoolClient();
    await pruneOperationalHistoryCurrent(client);
  }
  const currentMs = performance.now() - start;

  // Optimized
  start = performance.now();
  for (let i = 0; i < reps; i++) {
    const client = new MockPoolClient();
    await pruneOperationalHistoryOptimized(client);
  }
  const optimizedMs = performance.now() - start;

  console.log(`Current (4 round trips): ${currentMs.toFixed(2)}ms`);
  console.log(`Optimized (1 round trip): ${optimizedMs.toFixed(2)}ms`);
  console.log(`Improvement: ${(((currentMs - optimizedMs) / currentMs) * 100).toFixed(2)}%`);
}

runBenchmark().catch(console.error);
