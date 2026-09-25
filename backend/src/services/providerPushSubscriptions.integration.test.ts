// Real PostgreSQL tests for provider push subscriptions and the coalescing sync hints.
//
// The provider is not involved: these cases are about the local guarantee — one live subscription per scope,
// secrets stored only as hashes, a burst collapsing into one hint, and a notification that lands during a
// sync being queued rather than lost. Run with:
//
//   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
//     npx vitest run src/services/providerPushSubscriptions.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  claimDueSyncHints,
  clearSyncHintsForConnection,
  completeSyncHint,
  enqueueProviderSyncHint,
  failSyncHint,
  syncHintDiagnostics,
} from './providerSyncHints.js';
import {
  findLiveSubscription,
  hashPushSecret,
  listSubscriptionsDueForRenewal,
  markSubscriptionsRemoved,
  pushSecretMatches,
  recordSubscriptionFailure,
  recordSubscriptionNotification,
  upsertPushSubscription,
} from './providerPushSubscriptions.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-00000000f001';
const CONNECTION_ID = '00000000-0000-0000-0000-00000000f002';
const COLLECTION_ID = '00000000-0000-0000-0000-00000000f003';

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

describeOrSkip('provider push persistence (PostgreSQL)', () => {
  beforeAll(async () => {
    await autocommit(async client => {
      await client.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [USER_ID, 'push-user']);
      await client.query(
        `INSERT INTO provider_connections (id, user_id, provider, issuer, subject, provider_user_id, status)
         VALUES ($1, $2, 'google', 'https://accounts.google.com', 'push-subject', 'push@gmail.test', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [CONNECTION_ID, USER_ID],
      );
      await client.query(
        `INSERT INTO integration_collections (id, user_id, connection_id, kind, remote_id, source_access, user_access)
         VALUES ($1, $2, $3, 'calendar', 'calendar-1', 'read_write', 'read_only')
         ON CONFLICT (id) DO NOTHING`,
        [COLLECTION_ID, USER_ID, CONNECTION_ID],
      );
    });
  });

  afterAll(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_sync_hints WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM provider_push_subscriptions WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM integration_collections WHERE id = $1', [COLLECTION_ID]);
      await client.query('DELETE FROM provider_connections WHERE id = $1', [CONNECTION_ID]);
      await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    });
    // The pool is shared with every other suite in the process: ending it here would break the ones that run
    // after this file (they simply stop seeing their own rows).
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_sync_hints WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM provider_push_subscriptions WHERE user_id = $1', [USER_ID]);
    });
  });

  it('keeps one live subscription per scope and replaces it on a recreate', async () => {
    const first = await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'mail',
      providerSubscriptionId: 'watch-1', secret: 'secret-one', expiresAt: new Date(Date.now() + 3600_000),
    });
    const second = await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'mail',
      providerSubscriptionId: 'watch-2', secret: 'secret-two', expiresAt: new Date(Date.now() + 7200_000),
    });

    expect(second.id).toBe(first.id);
    const rows = await autocommit(client => client.query(
      'SELECT id, provider_subscription_id, status FROM provider_push_subscriptions WHERE user_id = $1',
      [USER_ID],
    ));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.provider_subscription_id).toBe('watch-2');
  });

  it('stores only the secret hash and compares it constant-time', async () => {
    await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'microsoft', resourceType: 'mail',
      providerSubscriptionId: 'sub-1', secret: 'the-client-state',
    });
    const stored = await autocommit(client => client.query<{ secret_hash: string | null }>(
      'SELECT secret_hash FROM provider_push_subscriptions WHERE user_id = $1', [USER_ID],
    ));
    const hash = stored.rows[0]?.secret_hash ?? '';
    expect(hash).not.toContain('the-client-state');
    expect(hash).toBe(hashPushSecret('the-client-state'));
    expect(pushSecretMatches('the-client-state', hash)).toBe(true);
    expect(pushSecretMatches('other', hash)).toBe(false);
    expect(pushSecretMatches(undefined, hash)).toBe(false);
  });

  it('lists subscriptions due for renewal with a safety margin and honours backoff', async () => {
    const soon = await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'mail',
      providerSubscriptionId: 'watch-soon', secret: 's1', expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'calendar',
      collectionId: COLLECTION_ID, providerSubscriptionId: 'channel-1', secret: 's2',
      expiresAt: new Date(Date.now() + 6 * 24 * 3600_000),
    });

    const due = await listSubscriptionsDueForRenewal({ aheadMinutes: 30 });
    expect(due.map(row => row.id)).toEqual([soon.id]);

    // A failure pushes the next attempt out, so the sweep does not retry on every tick.
    await recordSubscriptionFailure({ id: soon.id, code: 'RATE_LIMITED', retryAfterSeconds: 120 });
    const afterFailure = await listSubscriptionsDueForRenewal({ aheadMinutes: 30 });
    expect(afterFailure).toHaveLength(0);

    const failed = await autocommit(client => client.query<{ status: string; next_attempt_at: string | null; last_error_code: string | null }>(
      'SELECT status, next_attempt_at, last_error_code FROM provider_push_subscriptions WHERE id = $1', [soon.id],
    ));
    expect(failed.rows[0]?.status).toBe('failed');
    expect(failed.rows[0]?.last_error_code).toBe('RATE_LIMITED');
    expect(failed.rows[0]?.next_attempt_at).not.toBeNull();
  });

  it('tombstones subscriptions on removal and records the last notification', async () => {
    const subscription = await upsertPushSubscription({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'microsoft', resourceType: 'contacts',
      providerSubscriptionId: 'sub-2', secret: 's3', expiresAt: new Date(Date.now() + 3600_000),
    });
    await recordSubscriptionNotification(subscription.id);
    const live = await findLiveSubscription({ connectionId: CONNECTION_ID, resourceType: 'contacts' });
    expect(live?.last_notification_at).not.toBeNull();

    expect(await markSubscriptionsRemoved({ connectionId: CONNECTION_ID })).toBeGreaterThanOrEqual(1);
    expect(await findLiveSubscription({ connectionId: CONNECTION_ID, resourceType: 'contacts' })).toBeNull();
    const due = await listSubscriptionsDueForRenewal({ aheadMinutes: 30 });
    expect(due.some(row => row.id === subscription.id)).toBe(false);
  });

  it('collapses a burst into one hint and never loses a hint that arrives during a sync', async () => {
    for (let i = 0; i < 20; i += 1) {
      await enqueueProviderSyncHint({
        userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'mail', debounceMs: 0,
      });
    }
    expect((await syncHintDiagnostics()).pending).toBe(1);

    const claimed = await claimDueSyncHints({ owner: 'test-owner' });
    expect(claimed).toHaveLength(1);

    // A notification arriving while that sync runs must survive it.
    await enqueueProviderSyncHint({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'mail', debounceMs: 0,
    });
    const firstCompletion = await completeSyncHint(claimed[0]!.id);
    expect(firstCompletion.cleared).toBe(false);
    expect((await syncHintDiagnostics()).pending).toBe(1);

    const again = await claimDueSyncHints({ owner: 'test-owner' });
    expect(again).toHaveLength(1);
    expect((await completeSyncHint(again[0]!.id)).cleared).toBe(true);
    expect((await syncHintDiagnostics()).pending).toBe(0);
  });

  it('keeps a failed hint and retries it after its delay', async () => {
    await enqueueProviderSyncHint({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'microsoft', resourceType: 'calendar', debounceMs: 0,
    });
    const [claimed] = await claimDueSyncHints({ owner: 'test-owner' });
    await failSyncHint({ hintId: claimed!.id, code: 'PROVIDER_UNAVAILABLE', retryDelayMs: 60_000 });

    // Not due yet, and not gone.
    expect(await claimDueSyncHints({ owner: 'test-owner' })).toHaveLength(0);
    expect((await syncHintDiagnostics()).pending).toBe(1);

    await autocommit(client => client.query(
      "UPDATE provider_sync_hints SET run_after = NOW() - INTERVAL '1 second' WHERE id = $1", [claimed!.id],
    ));
    expect(await claimDueSyncHints({ owner: 'test-owner' })).toHaveLength(1);
  });

  it('drops every hint for a connection that was disconnected', async () => {
    await enqueueProviderSyncHint({
      userId: USER_ID, connectionId: CONNECTION_ID, provider: 'google', resourceType: 'calendar',
      collectionId: COLLECTION_ID, debounceMs: 0,
    });
    expect(await clearSyncHintsForConnection(CONNECTION_ID)).toBe(1);
    expect((await syncHintDiagnostics()).pending).toBe(0);
  });
});
