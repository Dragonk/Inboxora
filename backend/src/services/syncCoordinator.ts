import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';

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

/** The run no longer owns the lease. The caller must stop applying data, not retry it as a provider failure. */
export class SyncLeaseLostError extends Error {
  readonly code = 'SYNC_LEASE_LOST';
  constructor(message = 'The synchronization lease was lost, so this run must stop applying data') {
    super(message);
    this.name = 'SyncLeaseLostError';
  }
}

/**
 * Renew the lease **and** fence the surrounding transaction to the generation that owns it.
 *
 * The `UPDATE` extends the lease *and* takes the row lock, so inside one transaction the check and every write
 * it protects cannot interleave with a takeover: a superseded worker sees the newer generation here and stops,
 * while a takeover waits for the lock. Called at the start of each page-application transaction, this is the
 * heartbeat and the fence in one statement (SYNC-03). Throws `SyncLeaseLostError`.
 */
export async function fenceSyncLease(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
  leaseSeconds?: number;
}): Promise<void> {
  const held = await renewSyncLease(client, input);
  if (!held) throw new SyncLeaseLostError();
}

/**
 * Apply one page of provider data in a transaction fenced to the owning generation.
 *
 * Every write that projects provider data goes through here: the lease is renewed (heartbeat) and the
 * surrounding transaction is fenced to the generation before the write runs, so a worker whose lease expired
 * and was superseded cannot commit its page over the newer run's projection (SYNC-03). The network request that
 * produced the page happens **outside** this transaction, so no lock is ever held across a provider call.
 */
export async function withFencedSyncLease<T>(input: {
  syncStateId: string;
  generation: number;
  run: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  return withTransaction(async client => {
    await fenceSyncLease(client, { syncStateId: input.syncStateId, generation: input.generation });
    return input.run(client);
  });
}

export interface SyncCheckpoint {
  /**
   * Checkpoint fields use explicit patch semantics: a key that is **absent** leaves the stored value unchanged,
   * a key that is **present with `null`** clears it, and a key present with a string sets it.
   *
   * The previous `COALESCE($n, column)` could not tell "no change" from "clear", so the baseline transition
   * that means to drop a cursor Gmail has invalidated silently kept it and the next run re-read the expired
   * cursor (SYNC-02).
   */
  /** Opaque string; 64-bit provider history ids must not pass through a JS number. */
  cursor?: string | null;
  completedWatermark?: string | null;
  pageCheckpoint?: string | null;
  clearPageCheckpoint?: boolean;
  lastErrorCode?: string | null;
}

function has(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Persist a progress checkpoint for the current generation only. Returns false when the lease/generation guard
 * rejected the write, which the caller must report as a stale run rather than as success.
 *
 * This deliberately does **not** touch `last_success_at`: a checkpoint records where a run got to, not that the
 * declared scope was completed. Use `finishSyncRun` for the latter.
 */
export async function commitSyncCheckpoint(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
} & SyncCheckpoint): Promise<boolean> {
  const result = await client.query(
    `UPDATE sync_states
        SET cursor = CASE WHEN $3::boolean THEN $4::text ELSE cursor END,
            completed_watermark = CASE WHEN $5::boolean THEN $6::text ELSE completed_watermark END,
            page_checkpoint = CASE
                                WHEN $7::boolean THEN NULL
                                WHEN $8::boolean THEN $9::text
                                ELSE page_checkpoint
                              END,
            last_error_code = $10,
            updated_at = NOW()
      WHERE id = $1 AND running_generation = $2 AND lease_expires_at > NOW()
      RETURNING id`,
    [input.syncStateId, input.generation,
      has(input, 'cursor'), input.cursor ?? null,
      has(input, 'completedWatermark'), input.completedWatermark ?? null,
      Boolean(input.clearPageCheckpoint), has(input, 'pageCheckpoint'), input.pageCheckpoint ?? null,
      input.lastErrorCode ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * Mark the run that owns this lease as having completed its declared scope.
 *
 * Separate from `commitSyncCheckpoint` because the two mean different things (SYNC-02): the old single
 * statement stamped `last_success_at = NOW()` on **every** partial commit, so an interrupted baseline that had
 * stored one page looked like a successful synchronisation and the interface had no way to tell the difference.
 */
export async function finishSyncRun(client: PoolClient, input: {
  syncStateId: string;
  generation: number;
  lastErrorCode?: string | null;
}): Promise<boolean> {
  const result = await client.query(
    `UPDATE sync_states
        SET last_success_at = NOW(), last_error_code = $3,
            -- A completed clean run supersedes the failure it recovered from. Keeping
            -- its timestamp made account diagnostics select a historical error even
            -- though every calendar collection had subsequently synchronized.
            last_error_at = CASE WHEN $3::text IS NULL THEN NULL ELSE last_error_at END,
            updated_at = NOW()
      WHERE id = $1 AND running_generation = $2 AND lease_expires_at > NOW()
      RETURNING id`,
    [input.syncStateId, input.generation, input.lastErrorCode ?? null],
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
