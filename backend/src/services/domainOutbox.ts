import crypto from 'crypto';
import type { PoolClient } from 'pg';

/**
 * Domain outbox (P03, plan §5.1/§8.4).
 *
 * Notifications, search indexing, rule effects and conversation-engine updates
 * are written in the same transaction as the local change that produced them, so
 * "the row exists" and "the local commit happened" are the same fact. Delivery is
 * at-least-once with an idempotency key (`user_id, topic, dedupe_key`), a lease
 * bound to a claim token, and a bounded retry budget. A delivery retry therefore
 * cannot send a second mail: mail sending is not an outbox topic.
 */

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed';

const DEFAULT_LEASE_SECONDS = 60;

export interface EnqueueOutboxInput {
  userId: string;
  topic: string;
  /** Stable identity of one logical event: re-enqueuing it is a no-op. */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

/**
 * Enqueue one event. Returns `{ inserted: false }` when an event with the same
 * identity already exists, which makes the enqueue safe to repeat.
 */
export async function enqueueOutbox(client: PoolClient, input: EnqueueOutboxInput): Promise<{ id: string; inserted: boolean }> {
  const maxAttempts = Number.isFinite(input.maxAttempts) && Number(input.maxAttempts) > 0
    ? Math.floor(Number(input.maxAttempts))
    : 5;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO domain_outbox (user_id, topic, dedupe_key, payload, max_attempts)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (user_id, topic, dedupe_key) DO NOTHING
     RETURNING id`,
    [input.userId, input.topic, input.dedupeKey, JSON.stringify(input.payload ?? {}), maxAttempts],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM domain_outbox WHERE user_id = $1 AND topic = $2 AND dedupe_key = $3`,
    [input.userId, input.topic, input.dedupeKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('Could not enqueue or find the outbox event');
  return { id: row.id, inserted: false };
}

export interface ClaimedOutboxEvent {
  id: string;
  userId: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  claimToken: string;
}

/**
 * Claim due events for one worker. `FOR UPDATE SKIP LOCKED` lets several workers
 * drain the queue without ever handing the same event to two of them; the claim
 * token fences a worker whose lease expired while it was delivering.
 */
export async function claimDueOutbox(client: PoolClient, input: {
  limit?: number;
  leaseSeconds?: number;
} = {}): Promise<ClaimedOutboxEvent[]> {
  const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : 25;
  const leaseSeconds = Number.isFinite(input.leaseSeconds) && Number(input.leaseSeconds) > 0
    ? Math.floor(Number(input.leaseSeconds))
    : DEFAULT_LEASE_SECONDS;
  const claimToken = crypto.randomUUID();
  const result = await client.query<{
    id: string; user_id: string; topic: string; payload: Record<string, unknown>;
    attempts: number; max_attempts: number; claim_token: string;
  }>(
    `UPDATE domain_outbox o
        SET status = 'processing', claim_token = $1,
            lease_expires_at = NOW() + make_interval(secs => $2),
            attempts = attempts + 1, updated_at = NOW()
      WHERE o.id IN (
        SELECT id FROM domain_outbox
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY created_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id, o.user_id, o.topic, o.payload, o.attempts, o.max_attempts, o.claim_token`,
    [claimToken, leaseSeconds, limit],
  );
  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    topic: row.topic,
    payload: row.payload ?? {},
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
  }));
}

/** Mark a claimed event delivered. False means this worker no longer owns it. */
export async function completeOutbox(client: PoolClient, input: { id: string; claimToken: string }): Promise<boolean> {
  const result = await client.query(
    `UPDATE domain_outbox
        SET status = 'done', claim_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND claim_token = $2
      RETURNING id`,
    [input.id, input.claimToken],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * Record a failed delivery. It returns to `pending` with the given next attempt
 * until the attempt budget is exhausted, then parks as `failed` for diagnostics.
 */
export async function failOutbox(client: PoolClient, input: {
  id: string;
  claimToken: string;
  error: string;
  nextAttemptAt?: Date;
}): Promise<{ status: OutboxStatus; retrying: boolean } | null> {
  const result = await client.query<{ status: OutboxStatus }>(
    `UPDATE domain_outbox
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error = $3,
            next_attempt_at = CASE WHEN attempts >= max_attempts THEN NULL ELSE $4::timestamptz END,
            claim_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND claim_token = $2
      RETURNING status`,
    [input.id, input.claimToken, input.error.slice(0, 2000), input.nextAttemptAt ?? null],
  );
  const row = result.rows[0];
  return row ? { status: row.status, retrying: row.status === 'pending' } : null;
}

/**
 * Return events whose claim lease expired to the pending pool, so a crashed
 * worker cannot strand them in `processing`.
 */
export async function recoverExpiredOutbox(client: PoolClient): Promise<number> {
  const result = await client.query(
    `UPDATE domain_outbox
        SET status = 'pending', claim_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE status = 'processing' AND lease_expires_at <= NOW()`,
  );
  return result.rowCount ?? result.rows.length;
}
