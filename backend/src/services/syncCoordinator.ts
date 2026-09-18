import type { PoolClient } from 'pg';

/**
 * Sync-run lease and fencing (P03, plan §8.1).
 *
 * A sync run holds a lease on one `sync_states` row. Every acquire bumps a
 * monotonic generation, so a worker that restarted, was disabled, or was
 * superseded while still running cannot commit its result: the commit is
 * conditional on the generation it took *and* on an unexpired lease. Cursors are
 * only ever advanced through that guard, so a late page cannot rewind or skip
 * progress made by a newer run.
 */

export type SyncFeature = 'mail' | 'calendars' | 'contacts';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_LEASE_SECONDS = 120;

export interface SyncScope {
  userId: string;
  connectionId?: string | null;
  sourceConnectionId?: string | null;
  accountId?: string | null;
  feature: SyncFeature;
  collectionId?: string | null;
  coverage?: string;
}

/** Mirrors the `sync_states_scope_key` expression index. */
function scopePredicate(): string {
  return `user_id = $1
    AND COALESCE(connection_id, '${ZERO_UUID}'::uuid) = COALESCE($2::uuid, '${ZERO_UUID}'::uuid)
    AND COALESCE(source_connection_id, '${ZERO_UUID}'::uuid) = COALESCE($3::uuid, '${ZERO_UUID}'::uuid)
    AND COALESCE(account_id, '${ZERO_UUID}'::uuid) = COALESCE($4::uuid, '${ZERO_UUID}'::uuid)
    AND feature = $5
    AND COALESCE(collection_id, '${ZERO_UUID}'::uuid) = COALESCE($6::uuid, '${ZERO_UUID}'::uuid)
    AND coverage = $7`;
}

function scopeParams(scope: SyncScope): unknown[] {
  return [
    scope.userId, scope.connectionId ?? null, scope.sourceConnectionId ?? null,
    scope.accountId ?? null, scope.feature, scope.collectionId ?? null, scope.coverage ?? 'default',
  ];
}

/**
 * Find or create the state row for one scope. Safe against two workers racing:
 * the insert is idempotent through the scope index, and the loser re-reads.
 */
export async function ensureSyncState(client: PoolClient, scope: SyncScope): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM sync_states WHERE ${scopePredicate()}`,
    scopeParams(scope),
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO sync_states (user_id, connection_id, source_connection_id, account_id, feature, collection_id, coverage)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    scopeParams(scope),
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const retry = await client.query<{ id: string }>(
    `SELECT id FROM sync_states WHERE ${scopePredicate()}`,
    scopeParams(scope),
  );
  if (retry.rows[0]) return retry.rows[0].id;
  throw new Error('Could not create or find the sync state for this scope');
}

/** Take the run lease. `null` means another worker holds an unexpired one. */
export async function acquireSyncLease(client: PoolClient, input: {
  syncStateId: string;
  owner: string;
  leaseSeconds?: number;
}): Promise<{ generation: number } | null> {
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const result = await client.query<{ running_generation: string | number }>(
    `UPDATE sync_states
        SET running_generation = COALESCE(running_generation, 0) + 1,
            lease_expires_at = NOW() + make_interval(secs => $2),
            running_owner = $3,
            running_started_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
      RETURNING running_generation`,
    [input.syncStateId, leaseSeconds, input.owner],
  );
  const row = result.rows[0];
  return row ? { generation: Number(row.running_generation) } : null;
}

/** Extend a held lease. False means the lease was lost and the run must stop. */
export async function renewSyncLease(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
  leaseSeconds?: number;
}): Promise<boolean> {
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const result = await client.query(
    `UPDATE sync_states
        SET lease_expires_at = NOW() + make_interval(secs => $3), updated_at = NOW()
      WHERE id = $1 AND running_generation = $2 AND lease_expires_at > NOW()
      RETURNING id`,
    [input.syncStateId, input.generation, leaseSeconds],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Whether this generation still owns an unexpired lease. */
export async function syncLeaseHeld(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
}): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM sync_states WHERE id = $1 AND running_generation = $2 AND lease_expires_at > NOW()`,
    [input.syncStateId, input.generation],
  );
  return result.rows.length > 0;
}

export interface SyncCheckpoint {
  /** Opaque string; 64-bit provider history ids must not pass through a JS number. */
  cursor?: string | null;
  completedWatermark?: string | null;
  pageCheckpoint?: string | null;
  clearPageCheckpoint?: boolean;
  lastErrorCode?: string | null;
}

/**
 * Persist a checkpoint for the current generation only. Returns false when the
 * lease/generation guard rejected the write, which the caller must report as a
 * stale run rather than as success.
 */
export async function commitSyncCheckpoint(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
} & SyncCheckpoint): Promise<boolean> {
  const result = await client.query(
    `UPDATE sync_states
        SET cursor = COALESCE($3, cursor),
            completed_watermark = COALESCE($4, completed_watermark),
            page_checkpoint = CASE WHEN $5::boolean THEN NULL ELSE COALESCE($6, page_checkpoint) END,
            last_success_at = NOW(),
            last_error_code = $7,
            updated_at = NOW()
      WHERE id = $1 AND running_generation = $2 AND lease_expires_at > NOW()
      RETURNING id`,
    [input.syncStateId, input.generation, input.cursor ?? null, input.completedWatermark ?? null,
      Boolean(input.clearPageCheckpoint), input.pageCheckpoint ?? null, input.lastErrorCode ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Record a failed run and release the lease immediately. */
export async function failSyncRun(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
  errorCode: string;
}): Promise<boolean> {
  const result = await client.query(
    `UPDATE sync_states
        SET last_error_code = $3, last_error_at = NOW(),
            lease_expires_at = NULL, running_owner = NULL, updated_at = NOW()
      WHERE id = $1 AND running_generation = $2
      RETURNING id`,
    [input.syncStateId, input.generation, input.errorCode],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Release a lease without recording an error (e.g. the source was disabled). */
export async function releaseSyncLease(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
}): Promise<boolean> {
  const result = await client.query(
    `UPDATE sync_states
        SET lease_expires_at = NULL, running_owner = NULL, updated_at = NOW()
      WHERE id = $1 AND running_generation = $2
      RETURNING id`,
    [input.syncStateId, input.generation],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export interface SyncStateView {
  id: string;
  cursor: string | null;
  pageCheckpoint: string | null;
  completedWatermark: string | null;
  runningGeneration: number | null;
  leaseExpiresAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
}

export async function readSyncState(client: PoolClient, syncStateId: string): Promise<SyncStateView | null> {
  const result = await client.query<{
    id: string; cursor: string | null; page_checkpoint: string | null; completed_watermark: string | null;
    running_generation: string | number | null; lease_expires_at: Date | null; last_success_at: Date | null; last_error_code: string | null;
  }>(
    `SELECT id, cursor, page_checkpoint, completed_watermark, running_generation, lease_expires_at, last_success_at, last_error_code
       FROM sync_states WHERE id = $1`,
    [syncStateId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    cursor: row.cursor,
    pageCheckpoint: row.page_checkpoint,
    completedWatermark: row.completed_watermark,
    runningGeneration: row.running_generation === null ? null : Number(row.running_generation),
    leaseExpiresAt: row.lease_expires_at,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
  };
}
