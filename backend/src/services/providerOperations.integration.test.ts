// Real PostgreSQL tests for the P03 operation journal, sync leasing and outbox.
//
// These behaviours are about ownership across restart and concurrency, so a mocked
// database cannot prove them: the guarantees come from partial unique indexes,
// `FOR UPDATE SKIP LOCKED`, monotonic generations and lease timestamps. The suite
// runs only when a test database is configured (DB_HOST + DB_NAME), like the other
// PostgreSQL integration tests.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerOperations.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  beginOperation, completeOperation, findOperationByKey, renewOperationLease, scheduleOperationRetry,
} from './providerOperations.js';
import {
  acquireSyncLease, commitSyncCheckpoint, ensureSyncState, failSyncRun, readSyncState, releaseSyncLease, renewSyncLease, syncLeaseHeld,
} from './syncCoordinator.js';
import {
  claimDueOutbox, completeOutbox, enqueueOutbox, failOutbox, recoverExpiredOutbox,
} from './domainOutbox.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003b1';
const TOPIC = 'test.event';

/** Run a function inside a committed transaction on its own connection. */
async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Run a function with autocommit (each statement its own transaction). */
async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function expireOperationLease(operationId: string): Promise<void> {
  await autocommit(client => client.query(
    `UPDATE provider_operations SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
    [operationId],
  ));
}

async function expireSyncLease(syncStateId: string): Promise<void> {
  await autocommit(client => client.query(
    `UPDATE sync_states SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
    [syncStateId],
  ));
}

async function expireOutboxLease(id: string): Promise<void> {
  await autocommit(client => client.query(
    `UPDATE domain_outbox SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`,
    [id],
  ));
}

describeOrSkip('provider operation journal (PostgreSQL)', () => {
  beforeAll(async () => {
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p03-integration-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM domain_outbox WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM sync_states WHERE user_id = $1', [USER_ID]);
    });
  });

  it('replays a completed idempotent operation instead of running it twice', async () => {
    const started = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'calendar_event', operation: 'create',
      idempotencyKey: 'key-1', payloadHash: 'hash-1', owner: 'worker-a',
    }));
    expect(started.outcome).toBe('started');
    if (started.outcome !== 'started') throw new Error('expected a started operation');

    const completed = await inTransaction(client => completeOperation(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      status: 'committed', result: { remoteId: 'remote-1' },
    }));
    expect(completed).toBe(true);

    const replay = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'calendar_event', operation: 'create',
      idempotencyKey: 'key-1', payloadHash: 'hash-1', owner: 'worker-b',
    }));
    expect(replay).toMatchObject({ outcome: 'duplicate', status: 'committed', result: { remoteId: 'remote-1' } });

    const stored = await autocommit(client => findOperationByKey(client, { userId: USER_ID, idempotencyKey: 'key-1' }));
    expect(stored?.attempts).toBe(1);
  });

  it('treats the same key with a different payload as a conflict, not a replay', async () => {
    await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'contact', operation: 'create', idempotencyKey: 'key-2', payloadHash: 'hash-a',
    }));
    const conflict = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'contact', operation: 'create', idempotencyKey: 'key-2', payloadHash: 'hash-b',
    }));
    expect(conflict).toEqual({ outcome: 'conflict', reason: 'idempotency_key_reused' });
  });

  it('reports an unexpired in-flight claim instead of starting a second one', async () => {
    await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'message', operation: 'send', idempotencyKey: 'key-3', payloadHash: 'h',
    }));
    const second = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'message', operation: 'send', idempotencyKey: 'key-3', payloadHash: 'h',
    }));
    expect(second.outcome).toBe('in_progress');
  });

  it('fences a worker whose lease expired: it can no longer complete the operation', async () => {
    const started = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'calendar_event', operation: 'update',
      idempotencyKey: 'key-4', payloadHash: 'h', owner: 'worker-a',
    }));
    if (started.outcome !== 'started') throw new Error('expected a started operation');
    await expireOperationLease(started.operationId);

    const reclaimed = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'calendar_event', operation: 'update',
      idempotencyKey: 'key-4', payloadHash: 'h', owner: 'worker-b',
    }));
    expect(reclaimed.outcome).toBe('started');
    if (reclaimed.outcome !== 'started') throw new Error('expected the expired claim to be taken over');
    expect(reclaimed.generation).toBe(started.generation + 1);

    // The original worker's result is no longer authoritative.
    const stale = await inTransaction(client => completeOperation(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      status: 'committed', result: { stale: true },
    }));
    expect(stale).toBe(false);

    const fresh = await inTransaction(client => completeOperation(client, {
      operationId: reclaimed.operationId, claimToken: reclaimed.claimToken, generation: reclaimed.generation,
      status: 'committed', result: { fresh: true },
    }));
    expect(fresh).toBe(true);
  });

  it('parks an unconfirmed outcome so it is never retried automatically', async () => {
    const started = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'message', operation: 'send', idempotencyKey: 'key-5', payloadHash: 'h',
    }));
    if (started.outcome !== 'started') throw new Error('expected a started operation');
    await inTransaction(client => completeOperation(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      status: 'outcome_unknown', errorCode: 'SEND_OUTCOME_UNKNOWN',
    }));

    const retry = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'message', operation: 'send', idempotencyKey: 'key-5', payloadHash: 'h',
    }));
    expect(retry).toMatchObject({ outcome: 'duplicate', status: 'outcome_unknown' });
  });

  it('returns a retryable failure to the pending pool without letting a stale token touch it', async () => {
    const started = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'calendar_event', operation: 'delete', idempotencyKey: 'key-6', payloadHash: 'h',
    }));
    if (started.outcome !== 'started') throw new Error('expected a started operation');

    const scheduled = await inTransaction(client => scheduleOperationRetry(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      errorCode: 'RATE_LIMITED', nextAttemptAt: new Date(Date.now() + 60_000),
    }));
    expect(scheduled).toBe(true);

    const staleComplete = await inTransaction(client => completeOperation(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      status: 'failed',
    }));
    expect(staleComplete).toBe(false);

    const pending = await autocommit(client => findOperationByKey(client, { userId: USER_ID, idempotencyKey: 'key-6' }));
    expect(pending?.status).toBe('pending');
  });

  it('renews only a live claim', async () => {
    const started = await inTransaction(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'contact', operation: 'update', idempotencyKey: 'key-7', payloadHash: 'h',
    }));
    if (started.outcome !== 'started') throw new Error('expected a started operation');
    expect(await inTransaction(client => renewOperationLease(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
    }))).toBe(true);
    expect(await inTransaction(client => renewOperationLease(client, {
      operationId: started.operationId, claimToken: '00000000-0000-0000-0000-0000000000ff', generation: started.generation,
    }))).toBe(false);
  });
});

describeOrSkip('sync coordinator (PostgreSQL)', () => {
  const scope = { userId: USER_ID, feature: 'calendars' as const, coverage: 'default' };

  beforeAll(async () => {
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p03-integration-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM sync_states WHERE user_id = $1', [USER_ID]));
  });

  it('creates one state row per scope, even when two workers race', async () => {
    const first = await inTransaction(client => ensureSyncState(client, scope));
    const [a, b] = await Promise.all([
      inTransaction(client => ensureSyncState(client, scope)),
      inTransaction(client => ensureSyncState(client, scope)),
    ]);
    expect(a).toBe(first);
    expect(b).toBe(first);
  });

  it('hands the lease to exactly one of two concurrent workers', async () => {
    const syncStateId = await inTransaction(client => ensureSyncState(client, scope));
    const [first, second] = await Promise.all([
      inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-a' })),
      inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-b' })),
    ]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.generation).toBe(1);
  });

  it('rejects a stale generation and a lease that expired', async () => {
    const syncStateId = await inTransaction(client => ensureSyncState(client, scope));
    const run = await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-a' }));
    if (!run) throw new Error('expected the lease');
    expect(await inTransaction(client => commitSyncCheckpoint(client, {
      syncStateId, generation: run.generation, cursor: 'cursor-1',
    }))).toBe(true);

    // A second run takes over only after the first lease expires.
    expect(await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-b' }))).toBeNull();
    await expireSyncLease(syncStateId);
    const takeover = await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-b' }));
    expect(takeover?.generation).toBe(run.generation + 1);

    // The superseded generation can no longer advance the cursor.
    expect(await inTransaction(client => commitSyncCheckpoint(client, {
      syncStateId, generation: run.generation, cursor: 'stale-cursor',
    }))).toBe(false);
    const state = await autocommit(client => readSyncState(client, syncStateId));
    expect(state?.cursor).toBe('cursor-1');
  });

  it('refuses to commit after the lease was released or a run failed', async () => {
    const syncStateId = await inTransaction(client => ensureSyncState(client, scope));
    const run = await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'worker-a' }));
    if (!run) throw new Error('expected the lease');
    expect(await inTransaction(client => renewSyncLease(client, { syncStateId, generation: run.generation }))).toBe(true);
    expect(await inTransaction(client => syncLeaseHeld(client, { syncStateId, generation: run.generation }))).toBe(true);

    expect(await inTransaction(client => failSyncRun(client, { syncStateId, generation: run.generation, errorCode: 'PARTIAL_SYNC' }))).toBe(true);
    expect(await inTransaction(client => syncLeaseHeld(client, { syncStateId, generation: run.generation }))).toBe(false);
    expect(await inTransaction(client => commitSyncCheckpoint(client, { syncStateId, generation: run.generation, cursor: 'late' }))).toBe(false);
    expect(await inTransaction(client => releaseSyncLease(client, { syncStateId, generation: run.generation }))).toBe(true);

    const state = await autocommit(client => readSyncState(client, syncStateId));
    expect(state?.lastErrorCode).toBe('PARTIAL_SYNC');
    expect(state?.cursor).toBeNull();
  });
});

describeOrSkip('domain outbox (PostgreSQL)', () => {
  beforeAll(async () => {
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p03-integration-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM domain_outbox WHERE user_id = $1', [USER_ID]));
  });

  it('deduplicates one logical event by its key', async () => {
    const first = await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: 'event-1', payload: { a: 1 } }));
    const second = await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: 'event-1', payload: { a: 2 } }));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    const rows = await autocommit(client => client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM domain_outbox WHERE user_id = $1', [USER_ID]));
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('never hands the same event to two workers', async () => {
    for (const key of ['a', 'b', 'c']) {
      await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: key }));
    }
    const [first, second] = await Promise.all([
      inTransaction(client => claimDueOutbox(client, { limit: 2 })),
      inTransaction(client => claimDueOutbox(client, { limit: 2 })),
    ]);
    const ids = [...first, ...second].map(event => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
    expect(first.every(event => event.claimToken)).toBe(true);
  });

  it('completes only the claim that owns the event', async () => {
    const { id } = await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: 'owned' }));
    const claimed = await inTransaction(client => claimDueOutbox(client, { limit: 1 }));
    const event = claimed[0];
    if (!event) throw new Error('expected the event to be claimed');

    const wrong = await inTransaction(client => completeOutbox(client, { id, claimToken: '00000000-0000-0000-0000-0000000000ff' }));
    expect(wrong).toBe(false);
    const right = await inTransaction(client => completeOutbox(client, { id, claimToken: event.claimToken }));
    expect(right).toBe(true);
    expect(await inTransaction(client => claimDueOutbox(client, { limit: 1 }))).toHaveLength(0);
  });

  it('retries a failure with backoff and parks it once the budget is spent', async () => {
    const { id } = await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: 'retry', maxAttempts: 2 }));
    const firstClaim = (await inTransaction(client => claimDueOutbox(client, { limit: 1 })))[0];
    if (!firstClaim) throw new Error('expected a claim');

    // A future next_attempt_at keeps it out of the due set.
    const scheduled = await inTransaction(client => failOutbox(client, {
      id, claimToken: firstClaim.claimToken, error: 'temporary', nextAttemptAt: new Date(Date.now() + 60_000),
    }));
    expect(scheduled).toEqual({ status: 'pending', retrying: true });
    expect(await inTransaction(client => claimDueOutbox(client, { limit: 1 }))).toHaveLength(0);

    // Make it due again; the second claim exhausts the two-attempt budget.
    await autocommit(client => client.query(`UPDATE domain_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE id = $1`, [id]));
    const secondClaim = (await inTransaction(client => claimDueOutbox(client, { limit: 1 })))[0];
    if (!secondClaim) throw new Error('expected the retry to be claimable');
    const exhausted = await inTransaction(client => failOutbox(client, { id, claimToken: secondClaim.claimToken, error: 'still failing' }));
    expect(exhausted).toEqual({ status: 'failed', retrying: false });
    expect(await inTransaction(client => claimDueOutbox(client, { limit: 1 }))).toHaveLength(0);
  });

  it('returns an expired claim to the pending pool for recovery', async () => {
    const { id } = await inTransaction(client => enqueueOutbox(client, { userId: USER_ID, topic: TOPIC, dedupeKey: 'crash' }));
    const claimed = await inTransaction(client => claimDueOutbox(client, { limit: 1 }));
    expect(claimed).toHaveLength(1);
    await expireOutboxLease(id);
    const recovered = await inTransaction(client => recoverExpiredOutbox(client));
    expect(recovered).toBe(1);
    const reclaimed = await inTransaction(client => claimDueOutbox(client, { limit: 1 }));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.id).toBe(id);
  });
});
