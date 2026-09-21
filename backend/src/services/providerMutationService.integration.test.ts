// Real PostgreSQL tests for the shared provider-mutation layer (P03).
//
// The properties under test are about what a *crash* leaves behind and whether a
// recovered claim may run the provider call again. A mocked database cannot show
// that: the guarantees come from the claim being committed before the network call,
// from the lease, and from the monotonic generation that fences a superseded owner.
// The suite runs only when a test database is configured, like the other PostgreSQL
// integration tests.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providerMutationService.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { beginOperation, recordOperationProgress } from './providerOperations.js';
import type { ProviderAdapterOutcome, ProviderMutationAdapter } from './providerMutationService.js';
import { journalStatusFor, reclaimDecision, runProviderMutation } from './providerMutationService.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003c7';

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

async function operationRow(operationId: string): Promise<{ status: string; error_code: string | null; result: unknown; generation: string | number }> {
  const result = await autocommit(client => client.query<{ status: string; error_code: string | null; result: unknown; generation: string | number }>(
    'SELECT status, error_code, result, generation FROM provider_operations WHERE id = $1', [operationId],
  ));
  const row = result.rows[0];
  if (!row) throw new Error(`operation ${operationId} not found`);
  return row;
}

function adapter(
  perform: () => Promise<ProviderAdapterOutcome<string>>,
  idempotent: boolean,
  options: { resumeFrom?: (progress: Array<{ stage: string }>) => boolean } = {},
): ProviderMutationAdapter<void, string> {
  return {
    resourceType: 'test_resource',
    idempotent,
    ...(options.resumeFrom ? { resumeFrom: options.resumeFrom } : {}),
    perform: async () => perform(),
  };
}

function request(idempotencyKey: string, payloadHash = 'hash-1') {
  return {
    userId: USER_ID,
    channel: 'web' as const,
    operation: 'update' as const,
    resourceType: 'irrelevant',
    idempotencyKey,
    payloadHash,
    payload: undefined as void,
    leaseSeconds: 300,
  };
}

describeOrSkip('provider mutation layer (PostgreSQL)', () => {
  beforeAll(async () => {
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'p03-mutation-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    });
  });

  beforeEach(async () => {
    await autocommit(client => client.query('DELETE FROM provider_operations WHERE user_id = $1', [USER_ID]));
  });

  it('records a confirmed operation and reports the adapter value', async () => {
    let calls = 0;
    const result = await runProviderMutation(request('key-confirm'), adapter(async () => {
      calls += 1;
      return { status: 'committed', value: 'done' };
    }, true));

    expect(result.status).toBe('confirmed');
    expect(result.value).toBe('done');
    expect(result.replayed).toBe(false);
    expect(calls).toBe(1);
    const row = await operationRow(result.operationId!);
    expect(row.status).toBe('committed');
    expect(row.result).toBe('done');
  });

  it('keeps the claim durable and visible while the provider call is in flight', async () => {
    let observed: { status: string } | null = null;
    let operationId: string | null = null;

    await runProviderMutation(
      { ...request('key-in-flight'), owner: 'worker-a' },
      {
        resourceType: 'test_resource',
        idempotent: true,
        perform: async () => {
          const rows = await autocommit(client => client.query<{ status: string; id: string }>(
            `SELECT id, status FROM provider_operations WHERE user_id = $1 AND idempotency_key = 'key-in-flight'`,
            [USER_ID],
          ));
          observed = rows.rows[0] ?? null;
          operationId = rows.rows[0]?.id ?? null;
          return { status: 'committed', value: 'ok' };
        },
      },
    );

    // The row existed, and was claimed, before `perform` ran.
    expect(observed).not.toBeNull();
    expect((observed as unknown as { status: string }).status).toBe('in_flight');
    expect(operationId).not.toBeNull();
  });

  it('does not re-run a recovered non-idempotent operation, parking it as unknown', async () => {
    // A previous worker claimed the operation and stopped before recording an outcome.
    await autocommit(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'test_resource', operation: 'update',
      idempotencyKey: 'key-crashed', payloadHash: 'hash-1', leaseSeconds: 300,
    }));
    const claimed = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM provider_operations WHERE user_id = $1 AND idempotency_key = 'key-crashed'`, [USER_ID],
    ));
    await expireOperationLease(claimed.rows[0].id);

    let calls = 0;
    const result = await runProviderMutation(request('key-crashed'), adapter(async () => {
      calls += 1;
      return { status: 'committed', value: 'should not happen' };
    }, false));

    expect(calls).toBe(0);
    expect(result.status).toBe('outcome_unknown');
    expect(result.replayed).toBe(true);
    expect((await operationRow(result.operationId!)).status).toBe('outcome_unknown');
  });

  it('lets a non-idempotent adapter resume from the stages a recovered operation recorded', async () => {
    // CAL-01: parking is right when nothing is known about how far the previous owner got. An adapter that records
    // each of its steps can answer that question, so the remaining step is finished instead of abandoned.
    const started = await autocommit(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'test_resource', operation: 'update',
      idempotencyKey: 'key-crashed-resumable', payloadHash: 'hash-1', leaseSeconds: 300,
    }));
    if (started.outcome !== 'started') throw new Error('Expected a fresh operation');
    // The previous owner truncated the series, recorded that, and stopped before creating the remainder.
    await autocommit(client => recordOperationProgress(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      stage: 'master_truncated', detail: { masterId: 'series-1' },
    }));
    await expireOperationLease(started.operationId);

    const seen: Array<{ stage: string }> = [];
    let calls = 0;
    const result = await runProviderMutation(request('key-crashed-resumable'), adapter(async () => {
      calls += 1;
      return { status: 'committed', value: 'resumed' };
    }, false, {
      resumeFrom: progress => { seen.push(...progress); return progress.some(entry => entry.stage === 'master_truncated'); },
    }));

    expect(calls).toBe(1);
    expect(result.status).toBe('confirmed');
    expect(result.replayed).toBe(false);
    // The adapter was told what its predecessor had already done, which is what lets it skip that write.
    expect(seen).toContainEqual(expect.objectContaining({ stage: 'master_truncated' }));
  });

  it('reports what a parked operation had recorded, so the ambiguity is named', async () => {
    // CAL-01: an adapter that cannot resume is still parked — but "the remainder create was dispatched" is a
    // different state from "nothing is known", and it is the one a person has to reconcile by hand.
    const started = await autocommit(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'test_resource', operation: 'update',
      idempotencyKey: 'key-crashed-ambiguous', payloadHash: 'hash-1', leaseSeconds: 300,
    }));
    if (started.outcome !== 'started') throw new Error('Expected a fresh operation');
    await autocommit(client => recordOperationProgress(client, {
      operationId: started.operationId, claimToken: started.claimToken, generation: started.generation,
      stage: 'remainder_create_dispatched', detail: { occurrenceStart: '2026-09-15T09:00:00Z' },
    }));
    await expireOperationLease(started.operationId);

    const result = await runProviderMutation(request('key-crashed-ambiguous'), adapter(async () => {
      throw new Error('must not run');
    }, false));

    expect(result.status).toBe('outcome_unknown');
    expect(result.replayed).toBe(true);
    expect(result.progress).toEqual([
      expect.objectContaining({ stage: 'remainder_create_dispatched' }),
    ]);
  });

  it('re-runs a recovered idempotent operation, because re-applying it converges', async () => {
    await autocommit(client => beginOperation(client, {
      userId: USER_ID, resourceType: 'test_resource', operation: 'update',
      idempotencyKey: 'key-crashed-idempotent', payloadHash: 'hash-1', leaseSeconds: 300,
    }));
    const claimed = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM provider_operations WHERE user_id = $1 AND idempotency_key = 'key-crashed-idempotent'`, [USER_ID],
    ));
    await expireOperationLease(claimed.rows[0].id);

    let calls = 0;
    const result = await runProviderMutation(request('key-crashed-idempotent'), adapter(async () => {
      calls += 1;
      return { status: 'committed', value: 're-applied' };
    }, true));

    expect(calls).toBe(1);
    expect(result.status).toBe('confirmed');
    expect(result.value).toBe('re-applied');
  });

  it('answers an identical retry from the journal instead of calling the provider', async () => {
    let calls = 0;
    const perform = adapter(async () => { calls += 1; return { status: 'committed', value: 'once' }; }, true);
    const first = await runProviderMutation(request('key-replay'), perform);
    const second = await runProviderMutation(request('key-replay'), perform);

    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('confirmed');
    expect(second.replayed).toBe(true);
    expect(second.value).toBe('once');
    expect(calls).toBe(1);
  });

  it('refuses the same key with a different payload instead of executing it', async () => {
    let calls = 0;
    const perform = adapter(async () => { calls += 1; return { status: 'committed', value: 'x' }; }, true);
    await runProviderMutation(request('key-conflict', 'hash-a'), perform);
    const conflict = await runProviderMutation(request('key-conflict', 'hash-b'), perform);

    expect(conflict.status).toBe('conflict');
    expect(conflict.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(conflict.replayed).toBe(false);
    expect(calls).toBe(1);
  });

  it('schedules a retryable outcome and lets the next attempt re-claim it', async () => {
    let calls = 0;
    const perform = adapter(async () => {
      calls += 1;
      return calls === 1 ? { status: 'retryable', code: 'RATE_LIMITED' } : { status: 'committed', value: 'second' };
    }, true);

    const first = await runProviderMutation({ ...request('key-retry'), retry: { delaySeconds: 30 } }, perform);
    expect(first.status).toBe('retryable');
    expect((await operationRow(first.operationId!)).status).toBe('pending');

    const second = await runProviderMutation({ ...request('key-retry'), retry: { delaySeconds: 30 } }, perform);
    expect(second.status).toBe('confirmed');
    expect(second.value).toBe('second');
    expect(calls).toBe(2);
  });

  it('records a permanent failure with its code and does not retry it', async () => {
    let calls = 0;
    const perform = adapter(async () => { calls += 1; return { status: 'permanent', code: 'OPERATION_FORBIDDEN' }; }, true);
    const first = await runProviderMutation(request('key-permanent'), perform);
    expect(first.status).toBe('permanent');
    expect(first.code).toBe('OPERATION_FORBIDDEN');
    const row = await operationRow(first.operationId!);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('OPERATION_FORBIDDEN');

    const second = await runProviderMutation(request('key-permanent'), perform);
    expect(second.status).toBe('permanent');
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1);
  });

  it('treats an unclassified throw as an unknown outcome, never a retry', async () => {
    const result = await runProviderMutation(request('key-throw'), adapter(async () => {
      throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    }, false));

    expect(result.status).toBe('outcome_unknown');
    const row = await operationRow(result.operationId!);
    expect(row.status).toBe('outcome_unknown');
    expect(row.error_code).toBe('ECONNRESET');
  });

  it('does not report success when the claim was taken over mid-call', async () => {
    const result = await runProviderMutation(
      request('key-fenced'),
      {
        resourceType: 'test_resource',
        idempotent: true,
        perform: async (_payload, context) => {
          // Another worker takes the claim over while this one is on the network.
          await autocommit(client => client.query(
            `UPDATE provider_operations SET claim_token = gen_random_uuid(), generation = generation + 1 WHERE id = $1`,
            [context.operationId],
          ));
          return { status: 'committed', value: 'stale' };
        },
      },
    );

    expect(result.status).toBe('outcome_unknown');
    expect(result.code).toBe('MUTATION_OUTCOME_UNKNOWN');
  });

  it('accepts an acknowledged-but-unconfirmed result as accepted, not confirmed', async () => {
    const result = await runProviderMutation(request('key-accepted'), adapter(async () => ({ status: 'accepted_pending', value: 'queued' }), true));
    expect(result.status).toBe('accepted');
    expect((await operationRow(result.operationId!)).status).toBe('accepted_pending');
  });

  it('reports a conflict outcome from the adapter as a conflict', async () => {
    const result = await runProviderMutation(request('key-adapter-conflict'), adapter(async () => ({ status: 'conflict', code: 'VERSION_CONFLICT' }), true));
    expect(result.status).toBe('conflict');
    expect(result.code).toBe('VERSION_CONFLICT');
    expect((await operationRow(result.operationId!)).status).toBe('conflict');
  });
});

describe('the layer\'s pure decisions', () => {
  it('parks only a recovered non-idempotent operation', () => {
    expect(reclaimDecision(false, false)).toBe('run');
    expect(reclaimDecision(false, true)).toBe('run');
    expect(reclaimDecision(true, true)).toBe('run');
    expect(reclaimDecision(true, false)).toBe('park');
  });

  it('maps every terminal outcome to a journal status', () => {
    expect(journalStatusFor({ status: 'committed' })).toBe('committed');
    expect(journalStatusFor({ status: 'accepted_pending' })).toBe('accepted_pending');
    expect(journalStatusFor({ status: 'conflict' })).toBe('conflict');
    expect(journalStatusFor({ status: 'permanent', code: 'X' })).toBe('failed');
    expect(journalStatusFor({ status: 'outcome_unknown' })).toBe('outcome_unknown');
  });
});
