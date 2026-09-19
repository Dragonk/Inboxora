import crypto from 'crypto';
import type { PoolClient } from 'pg';

/**
 * Durable journal for externally-visible provider mutations (P03, plan §5.1/§8.3).
 *
 * One row records the intent, the owner that is allowed to finish it and the
 * outcome. The contract exists because a provider call cannot join the local SQL
 * transaction:
 *
 *  - an identical retry of a completed operation replays the stored result;
 *  - the same idempotency key with a different payload is a conflict, never a
 *    second provider call;
 *  - only the claim token + generation that began the operation may complete it,
 *    so a restarted, superseded or duplicated worker cannot overwrite a newer
 *    result;
 *  - a mutation whose outcome could not be confirmed is parked as
 *    `outcome_unknown` and is never retried automatically.
 */

export type ProviderOperationStatus =
  | 'pending'
  | 'in_flight'
  | 'committed'
  | 'accepted_pending'
  | 'outcome_unknown'
  | 'conflict'
  | 'failed'
  | 'cancelled';

/** Terminal states in which an identical retry is answered from the journal. */
const REPLAYABLE_STATUSES: readonly ProviderOperationStatus[] = ['committed', 'accepted_pending'];
/** States that require reconciliation by a human/policy, never an automatic retry. */
const UNRESOLVED_STATUSES: readonly ProviderOperationStatus[] = ['outcome_unknown', 'conflict', 'failed', 'cancelled'];

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_LEASE_SECONDS = 300;

export interface BeginOperationInput {
  userId: string;
  accountId?: string | null;
  connectionId?: string | null;
  collectionId?: string | null;
  resourceType: string;
  operation: string;
  resourceId?: string | null;
  /** Stable key of one logical intent; required for replay semantics. */
  idempotencyKey?: string | null;
  /** Fingerprint of the intent; the same key with a different hash is a conflict. */
  payloadHash?: string | null;
  expectedVersions?: Record<string, unknown>;
  leaseSeconds?: number;
  /** Worker identity for diagnostics only. */
  owner?: string | null;
}

export type BeginOperationResult =
  | {
    outcome: 'started';
    operationId: string;
    claimToken: string;
    generation: number;
    /**
     * True when this claim took over an existing `in_flight` operation whose lease
     * had expired, rather than beginning a new one. A caller must not re-run a
     * non-idempotent provider call in that case: the previous owner may have
     * dispatched it before it stopped.
     */
    reclaimed: boolean;
  }
  | { outcome: 'duplicate'; operationId: string; status: ProviderOperationStatus; result?: unknown; errorCode?: string | null }
  | { outcome: 'in_progress'; operationId: string; status: ProviderOperationStatus }
  | { outcome: 'conflict'; reason: 'idempotency_key_reused' };

interface OperationRow {
  id: string;
  status: ProviderOperationStatus;
  payload_hash: string | null;
  result: unknown;
  error_code: string | null;
  claim_token: string | null;
  generation: string | number;
  lease_expires_at: string | Date | null;
  attempts: number;
}

function scopedIdempotencyPredicate(): string {
  // Must mirror the `provider_operations_idempotency_key` expression index so the
  // conflict target and the lookup agree on the scope.
  return `user_id = $1 AND COALESCE(account_id, '${ZERO_UUID}'::uuid) = COALESCE($2::uuid, '${ZERO_UUID}'::uuid) AND idempotency_key = $3`;
}

function leaseExpired(value: string | Date | null): boolean {
  if (!value) return true;
  return new Date(value).getTime() <= Date.now();
}

/**
 * Claim an operation. The caller must already be inside a transaction: the claim
 * and the local side effects it guards must commit together.
 */
export async function beginOperation(client: PoolClient, input: BeginOperationInput): Promise<BeginOperationResult> {
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const idempotencyKey = input.idempotencyKey ?? null;
  const payloadHash = input.payloadHash ?? null;
  const expectedVersions = JSON.stringify(input.expectedVersions ?? {});

  const insert = await client.query<{ id: string; claim_token: string; generation: string | number }>(
    `INSERT INTO provider_operations
       (user_id, account_id, connection_id, collection_id, resource_type, operation, resource_id,
        idempotency_key, payload_hash, status, expected_versions, claim_token, claimed_at,
        lease_expires_at, owner, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_flight',$10::jsonb,$11,NOW(),
             NOW() + make_interval(secs => $12), $13, 1)
     ${idempotencyKey === null ? '' : 'ON CONFLICT DO NOTHING'}
     RETURNING id, claim_token, generation`,
    [
      input.userId, input.accountId ?? null, input.connectionId ?? null, input.collectionId ?? null,
      input.resourceType, input.operation, input.resourceId ?? null,
      idempotencyKey, payloadHash, expectedVersions, crypto.randomUUID(), leaseSeconds, input.owner ?? null,
    ],
  );
  const started = insert.rows[0];
  if (started) {
    return { outcome: 'started', operationId: started.id, claimToken: started.claim_token, generation: Number(started.generation), reclaimed: false };
  }

  // The row already exists for this key. Lock it so two concurrent retries cannot
  // both decide to reclaim the same expired claim.
  const existing = await client.query<OperationRow>(
    `SELECT id, status, payload_hash, result, error_code, claim_token, generation, lease_expires_at, attempts
       FROM provider_operations
      WHERE ${scopedIdempotencyPredicate()}
      FOR UPDATE`,
    [input.userId, input.accountId ?? null, idempotencyKey],
  );
  const row = existing.rows[0];
  // A missing row here means the insert failed for another reason; surface it as a
  // conflict rather than silently starting a second operation.
  if (!row) return { outcome: 'conflict', reason: 'idempotency_key_reused' };

  if ((row.payload_hash ?? '') !== (payloadHash ?? '')) {
    return { outcome: 'conflict', reason: 'idempotency_key_reused' };
  }
  if (REPLAYABLE_STATUSES.includes(row.status)) {
    return { outcome: 'duplicate', operationId: row.id, status: row.status, result: row.result, errorCode: row.error_code };
  }
  if (UNRESOLVED_STATUSES.includes(row.status)) {
    // Never retry an unconfirmed or conflicting mutation; the caller reconciles.
    return { outcome: 'duplicate', operationId: row.id, status: row.status, result: row.result, errorCode: row.error_code };
  }
  if (row.status === 'in_flight' && !leaseExpired(row.lease_expires_at)) {
    return { outcome: 'in_progress', operationId: row.id, status: row.status };
  }

  // `pending`, or an `in_flight` row whose lease expired: take it over with a new
  // generation, which fences the previous owner out of completing it.
  const reclaim = await client.query<{ id: string; claim_token: string; generation: string | number }>(
    `UPDATE provider_operations
        SET status = 'in_flight', claim_token = $3, generation = generation + 1,
            claimed_at = NOW(), lease_expires_at = NOW() + make_interval(secs => $4),
            owner = $5, attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1 AND generation = $2
      RETURNING id, claim_token, generation`,
    [row.id, row.generation, crypto.randomUUID(), leaseSeconds, input.owner ?? null],
  );
  const claimed = reclaim.rows[0];
  if (!claimed) return { outcome: 'in_progress', operationId: row.id, status: 'in_flight' };
  return { outcome: 'started', operationId: claimed.id, claimToken: claimed.claim_token, generation: Number(claimed.generation), reclaimed: true };
}

export interface CompleteOperationInput {
  operationId: string;
  claimToken: string;
  generation: number;
  status: Extract<ProviderOperationStatus, 'committed' | 'accepted_pending' | 'outcome_unknown' | 'conflict' | 'failed' | 'cancelled'>;
  result?: unknown;
  upstreamRef?: Record<string, unknown> | null;
  errorCode?: string | null;
}

/**
 * Finish an operation. Returns false when this worker no longer owns the claim
 * (expired lease, superseded generation), in which case the caller must not treat
 * its result as authoritative.
 */
export async function completeOperation(client: PoolClient, input: CompleteOperationInput): Promise<boolean> {
  const result = await client.query(
    `UPDATE provider_operations
        SET status = $4, result = $5::jsonb, upstream_ref = $6::jsonb, error_code = $7,
            claim_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND claim_token = $2 AND generation = $3
      RETURNING id`,
    [input.operationId, input.claimToken, input.generation, input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.upstreamRef ? JSON.stringify(input.upstreamRef) : null,
      input.errorCode ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Return a retryable operation to the pending pool without losing ownership fencing. */
export async function scheduleOperationRetry(client: PoolClient, input: {
  operationId: string;
  claimToken: string;
  generation: number;
  errorCode?: string | null;
  nextAttemptAt: Date;
}): Promise<boolean> {
  const result = await client.query(
    `UPDATE provider_operations
        SET status = 'pending', error_code = $4, next_attempt_at = $5,
            claim_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND claim_token = $2 AND generation = $3
      RETURNING id`,
    [input.operationId, input.claimToken, input.generation, input.errorCode ?? null, input.nextAttemptAt],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Extend a running lease; false when the operation is no longer owned by this claim. */
export async function renewOperationLease(client: PoolClient, input: {
  operationId: string;
  claimToken: string;
  generation: number;
  leaseSeconds?: number;
}): Promise<boolean> {
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const result = await client.query(
    `UPDATE provider_operations
        SET lease_expires_at = NOW() + make_interval(secs => $4), updated_at = NOW()
      WHERE id = $1 AND claim_token = $2 AND generation = $3 AND status = 'in_flight'
      RETURNING id`,
    [input.operationId, input.claimToken, input.generation, leaseSeconds],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Read an operation by its idempotency scope (diagnostics and reconciliation). */
export async function findOperationByKey(client: PoolClient, input: {
  userId: string;
  accountId?: string | null;
  idempotencyKey: string;
}): Promise<{ id: string; status: ProviderOperationStatus; result?: unknown; attempts: number } | null> {
  const result = await client.query<{ id: string; status: ProviderOperationStatus; result: unknown; attempts: number }>(
    `SELECT id, status, result, attempts FROM provider_operations WHERE ${scopedIdempotencyPredicate()}`,
    [input.userId, input.accountId ?? null, input.idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, result: row.result, attempts: row.attempts } : null;
}
