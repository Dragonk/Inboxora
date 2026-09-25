import { query } from './db.js';
import { syncHintDebounceMs } from './providerPushConfig.js';

/**
 * The one place a provider notification becomes work.
 *
 * A webhook never runs a sync in the request thread and never treats its payload as authoritative state: it
 * enqueues a **hint** naming the connection and resource that changed, and the existing delta/history/
 * sync-token sync decides what actually changed. The hint is a single row per (connection, resource,
 * collection), so a burst collapses; `requested_at` moves forward on every notification, and a run deletes
 * the row only when no newer hint arrived while it ran — a notification that lands during a sync is
 * therefore queued, not lost.
 *
 * Persistence is PostgreSQL, which is already there: no second broker, and a hint survives a restart, which
 * is what makes "webhook received, process died before the sync" a delay rather than a missed change.
 */

export type SyncHintResourceType = 'mail' | 'calendar' | 'contacts';

export interface SyncHintInput {
  userId: string;
  connectionId: string;
  provider: 'microsoft' | 'google';
  resourceType: SyncHintResourceType;
  /** The pulled collection this hint is about, for a per-collection resource such as a calendar. */
  collectionId?: string | null;
  /** Overrides the debounce window (tests use it to make the window deterministic). */
  debounceMs?: number;
}

/**
 * Record that a resource changed.
 *
 * Idempotent by construction: the unique scope index turns a burst into one row whose `run_after` moves
 * forward, and a hint that is currently being synced is left claimed and picked up again afterwards.
 */
export async function enqueueProviderSyncHint(input: SyncHintInput): Promise<{ enqueued: boolean; coalesced: boolean }> {
  const debounceMs = input.debounceMs ?? syncHintDebounceMs();
  const result = await query<{ inserted: boolean }>(
    `INSERT INTO provider_sync_hints
       (user_id, provider_connection_id, provider, resource_type, collection_id, requested_at, run_after)
     VALUES ($1,$2,$3,$4,$5, NOW(), NOW() + make_interval(secs => $6))
     ON CONFLICT (provider_connection_id, resource_type, COALESCE(collection_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET
       requested_at = NOW(),
       -- A hint that arrives while its scope is being synced stays due for the next pass.
       run_after = NOW() + make_interval(secs => $6),
       updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      input.userId, input.connectionId, input.provider, input.resourceType, input.collectionId ?? null,
      Math.max(0, debounceMs) / 1000,
    ],
  );
  return { enqueued: true, coalesced: result.rows[0]?.inserted === false };
}

export interface ClaimedSyncHint {
  id: string;
  userId: string;
  connectionId: string;
  provider: 'microsoft' | 'google';
  resourceType: SyncHintResourceType;
  collectionId: string | null;
  claimedAt: string;
  attempts: number;
}

/**
 * Claim the hints that are due, at most one claim per scope, without blocking on a scope another worker
 * holds. `SKIP LOCKED` is what lets two workers share the queue instead of serialising behind each other.
 */
export async function claimDueSyncHints(input: { owner: string; limit?: number }): Promise<ClaimedSyncHint[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 20), 200);
  const result = await query<{
    id: string; user_id: string; provider_connection_id: string; provider: 'microsoft' | 'google';
    resource_type: SyncHintResourceType; collection_id: string | null; claimed_at: string; attempts: number;
  }>(
    `UPDATE provider_sync_hints
        SET claimed_at = NOW(), claim_owner = $1, attempts = attempts + 1, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM provider_sync_hints
         WHERE run_after <= NOW()
           AND (claimed_at IS NULL OR claimed_at <= NOW() - INTERVAL '10 minutes')
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT $2
      )
      RETURNING id, user_id, provider_connection_id, provider, resource_type, collection_id, claimed_at, attempts`,
    [input.owner, limit],
  );
  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    connectionId: row.provider_connection_id,
    provider: row.provider,
    resourceType: row.resource_type,
    collectionId: row.collection_id,
    claimedAt: row.claimed_at,
    attempts: row.attempts,
  }));
}

/**
 * Finish a claimed hint.
 *
 * The delete is conditional on nothing newer having arrived: a notification that landed while the sync ran
 * bumped `requested_at`, so the row survives and the next pass syncs again. This is the whole reason a
 * notification cannot be swallowed by a concurrent sync.
 */
export async function completeSyncHint(hintId: string): Promise<{ cleared: boolean }> {
  const result = await query(
    `DELETE FROM provider_sync_hints
      WHERE id = $1 AND requested_at <= claimed_at`,
    [hintId],
  );
  if ((result.rowCount ?? 0) > 0) return { cleared: true };
  // A newer notification arrived during the run: release the claim so the next pass runs again.
  await query(
    `UPDATE provider_sync_hints SET claimed_at = NULL, claim_owner = NULL, updated_at = NOW()
      WHERE id = $1`,
    [hintId],
  );
  return { cleared: false };
}

/** A failed attempt: keep the hint, record why, and let the next pass retry after the debounce window. */
export async function failSyncHint(input: { hintId: string; code: string; retryDelayMs?: number }): Promise<void> {
  const delaySeconds = Math.max(5, Math.floor((input.retryDelayMs ?? 60_000) / 1000));
  await query(
    `UPDATE provider_sync_hints
        SET claimed_at = NULL, claim_owner = NULL, last_error_code = $2,
            run_after = NOW() + make_interval(secs => $3), updated_at = NOW()
      WHERE id = $1`,
    [input.hintId, input.code, delaySeconds],
  );
}

/** Drop every hint for a connection, so a disconnected provider connection cannot be synced again. */
export async function clearSyncHintsForConnection(connectionId: string): Promise<number> {
  const result = await query('DELETE FROM provider_sync_hints WHERE provider_connection_id = $1', [connectionId]);
  return result.rowCount ?? 0;
}

/** Diagnostics: how many hints are waiting, and the oldest one. */
export async function syncHintDiagnostics(): Promise<{ pending: number; oldestRequestedAt: string | null }> {
  const result = await query<{ pending: string; oldest: string | null }>(
    'SELECT COUNT(*)::text AS pending, MIN(requested_at)::text AS oldest FROM provider_sync_hints',
  );
  return {
    pending: Number(result.rows[0]?.pending ?? 0),
    oldestRequestedAt: result.rows[0]?.oldest ?? null,
  };
}
