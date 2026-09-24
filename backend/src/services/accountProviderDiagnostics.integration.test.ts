import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from './db.js';
import { GOOGLE_GRANT_AUDIENCE, storeOAuthGrant, upsertProviderConnection } from './providerAuthService.js';
import { describeAccountProviderFeatures } from './accountProviderFeatures.js';
import { providerSyncPreflight } from './providerSyncDiagnostics.js';
import { commitSyncCheckpoint, ensureSyncState, failSyncRun, finishSyncRun } from './syncCoordinator.js';

/**
 * Per-account provider diagnostics, on real PostgreSQL.
 *
 * These cases are about what the interface is allowed to learn and from where: one user's own account, the
 * capability evaluator's verdict (never "a connection exists"), the last recorded run from `sync_states`, the
 * push state, and the absence of any credential in the answer.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=<db> DB_USER=mailflow_test DB_PASSWORD=mailflow_test \
 *     npx vitest run src/services/accountProviderDiagnostics.integration.test.ts
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_A = '00000000-0000-0000-0000-0000000d0001';
const USER_B = '00000000-0000-0000-0000-0000000d0002';
const GOOGLE = 'https://www.googleapis.com/auth/';

let accountId = '';

async function inTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
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

beforeAll(async () => {
  if (!hasPg) return;
  process.env.ENCRYPTION_KEY ||= 'd'.repeat(64);
  await query("INSERT INTO users (id, username) VALUES ($1, 'diag-a'), ($2, 'diag-b') ON CONFLICT (id) DO NOTHING", [USER_A, USER_B]);
  const account = await query<{ id: string }>(
    `INSERT INTO email_accounts (user_id, name, email_address, imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass, mail_transport, oauth_provider)
     VALUES ($1, 'Diagnostics', 'diag@gmail.test', 'imap.gmail.com', 993, 'smtp.gmail.com', 587, 'diag@gmail.test', 'x', 'gmail_api', NULL)
     RETURNING id`,
    [USER_A],
  );
  accountId = account.rows[0]!.id;
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM email_accounts WHERE user_id = ANY($1::uuid[])', [[USER_A, USER_B]]);
  await query('DELETE FROM provider_connections WHERE user_id = ANY($1::uuid[])', [[USER_A, USER_B]]);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[USER_A, USER_B]]);
});

describeOrSkip('account provider diagnostics (PostgreSQL)', () => {
  it('returns nothing for an account that belongs to another user', async () => {
    const foreign = await describeAccountProviderFeatures({ userId: USER_B, accountId });
    expect(foreign).toBeNull();
  });

  it('reports authorization per feature from the grant, never from the connection existing', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_A, provider: 'google', issuer: 'https://accounts.google.com',
      subject: 'diag-subject', providerUserId: 'diag@gmail.test',
    }));
    // Only the Gmail scope: mail is authorized, calendar and contacts are not, and the missing scopes are
    // named so the interface can offer the right action.
    await inTransaction(client => storeOAuthGrant(client, {
      connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'a', refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000), scopes: [`${GOOGLE}gmail.modify`], clientIdAtIssue: 'client-1',
    }));

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features).not.toBeNull();
    expect(features!.diagnostics.connection).toMatchObject({ provider: 'google', identity: 'diag@gmail.test', status: 'active' });
    expect(features!.diagnostics.mail.authorized).toBe(true);
    expect(features!.diagnostics.mail.missingScopes).toEqual([]);
    expect(features!.diagnostics.calendar.authorized).toBe(false);
    expect(features!.diagnostics.calendar.missingScopes).toEqual(['calendar.calendarlist.readonly', 'calendar.events']);
    expect(features!.diagnostics.contacts.authorized).toBe(false);
    expect(features!.diagnostics.contacts.missingScopes).toEqual(['contacts']);
    // Gmail contacts have no push channel, so the diagnostics say polling rather than inventing a status.
    expect(features!.diagnostics.contacts.push).toBe('polling');

    // The answer carries no credential field at all, not even a null one.
    const serialized = JSON.stringify(features);
    for (const forbidden of ['access_token', 'refresh_token', 'accessToken', 'refreshToken', 'clientSecret', 'encrypted']) {
      expect(serialized, `${forbidden} leaked into the diagnostics`).not.toContain(forbidden);
    }
  });

  it('reports a revoked grant as unauthorized', async () => {
    await query("UPDATE oauth_grants SET status = 'revoked' WHERE connection_id IN (SELECT id FROM provider_connections WHERE user_id = $1)", [USER_A]);
    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.mail.authorized).toBe(false);
    expect(features!.diagnostics.mail.missingScopes).toEqual(['gmail.modify']);
    // The connection is still named, because "it was disconnected" is the answer a failing sync needs.
    expect(features!.diagnostics.connection?.identity).toBe('diag@gmail.test');
    await query("UPDATE oauth_grants SET status = 'active' WHERE connection_id IN (SELECT id FROM provider_connections WHERE user_id = $1)", [USER_A]);
  });

  it('reports the last successful run, the last error and whether a cursor exists', async () => {
    const { syncStateId } = await inTransaction(async client => {
      const id = await ensureSyncState(client, {
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'history',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [id],
      );
      const leaseGeneration = Number(lease.rows[0]!.running_generation);
      await commitSyncCheckpoint(client, { syncStateId: id, generation: leaseGeneration, cursor: 'history-42' });
      // A checkpoint records progress; only finishing the run claims a successful synchronisation (SYNC-02).
      await finishSyncRun(client, { syncStateId: id, generation: leaseGeneration, lastErrorCode: null });
      await failSyncRun(client, { syncStateId: id, generation: leaseGeneration, errorCode: 'RATE_LIMITED' });
      return { syncStateId: id };
    });
    expect(syncStateId).toBeTruthy();

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.mail.lastSuccessfulSync).not.toBeNull();
    expect(features!.diagnostics.mail.lastErrorCode).toBe('RATE_LIMITED');
    expect(features!.diagnostics.mail.cursorPresent).toBe(true);
    expect(features!.diagnostics.mail.transport).toBe('gmail_api');
    // OBS-03: a native transport with no active subscription only polls, so the label must not claim push.
    expect(features!.diagnostics.mail.scheduler).toBe('scheduled');
    // A feature with no recorded run says so instead of inventing a time.
    expect(features!.diagnostics.calendar.lastSuccessfulSync).toBeNull();
    expect(features!.diagnostics.calendar.lastErrorCode).toBeNull();
  });

  it('does not report a recovered collection failure as a current feature error', async () => {
    const connection = await query<{ id: string }>('SELECT id FROM provider_connections WHERE user_id = $1 AND provider = $2 ORDER BY created_at ASC LIMIT 1', [USER_A, 'google']);
    const connectionId = connection.rows[0]!.id;
    const localCalendar = await query<{ id: string }>(
      "INSERT INTO calendars (user_id, name, owner_user_id) VALUES ($1, 'Recovered diagnostics', $1) RETURNING id",
      [USER_A],
    );
    const collection = await query<{ id: string }>(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, 'calendar', 'recovered-diagnostics', $3, true, 'read_write', 'source', 'off')
       RETURNING id`,
      [USER_A, connectionId, localCalendar.rows[0]!.id],
    );
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_A, connectionId, accountId: null, feature: 'calendars', collectionId: collection.rows[0]!.id, coverage: 'events',
    }));
    // Simulate a row written by an earlier release: it retained the historical
    // code/time even after a later successful run. The account card must ignore it.
    await query(
      `UPDATE sync_states
          SET last_error_code = 'PROVIDER_API_DISABLED',
              last_error_at = NOW() - interval '1 minute',
              last_success_at = NOW()
        WHERE id = $1`,
      [syncStateId],
    );

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.calendar.lastSuccessfulSync).not.toBeNull();
    expect(features!.diagnostics.calendar.lastErrorCode).toBeNull();
    expect(features!.diagnostics.calendar.lastErrorAt).toBeNull();
  });

  it('ignores a retired collection failure but retains an active sibling failure', async () => {
    const connection = await query<{ id: string }>('SELECT id FROM provider_connections WHERE user_id = $1 AND provider = $2 ORDER BY created_at ASC LIMIT 1', [USER_A, 'google']);
    const connectionId = connection.rows[0]!.id;
    await query('DELETE FROM sync_states WHERE user_id = $1 AND connection_id = $2 AND feature IN (\'calendar\', \'calendars\', \'contacts\')', [USER_A, connectionId]);
    await query('DELETE FROM integration_collections WHERE user_id = $1 AND connection_id = $2', [USER_A, connectionId]);
    const local = await query<{ id: string }>(
      "INSERT INTO calendars (user_id, name, owner_user_id) VALUES ($1, 'Active diagnostics', $1), ($1, 'Retired diagnostics', $1) RETURNING id",
      [USER_A],
    );
    const collections = await query<{ id: string; remote_id: string }>(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, 'calendar', 'active-diagnostics', $3, true, 'read_write', 'source', 'off'),
              ($1, $2, 'calendar', 'retired-diagnostics', $4, false, 'read_write', 'source', 'off')
       RETURNING id, remote_id`,
      [USER_A, connectionId, local.rows[0]!.id, local.rows[1]!.id],
    );
    const active = collections.rows.find(collection => collection.remote_id === 'active-diagnostics')!;
    const retired = collections.rows.find(collection => collection.remote_id === 'retired-diagnostics')!;
    await query(
      `INSERT INTO sync_states (user_id, connection_id, feature, collection_id, coverage, last_success_at, last_error_code, last_error_at)
       VALUES ($1, $2, 'calendars', $3, 'events', NOW(), NULL, NULL),
              ($1, $2, 'calendars', $4, 'events', NOW() - interval '1 hour', 'PROVIDER_API_DISABLED', NOW() - interval '30 minutes')`,
      [USER_A, connectionId, active.id, retired.id],
    );

    let features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.calendar.lastErrorCode).toBeNull();
    expect(features!.calendar!.syncErrorCode).toBeNull();

    await query('UPDATE integration_collections SET enabled = true WHERE id = $1', [retired.id]);
    features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.calendar.lastErrorCode).toBe('PROVIDER_API_DISABLED');
    expect(features!.calendar!.syncErrorCode).toBe('PROVIDER_API_DISABLED');

    await query('DELETE FROM sync_states WHERE user_id = $1 AND connection_id = $2 AND feature IN (\'calendar\', \'calendars\', \'contacts\')', [USER_A, connectionId]);
    await query('DELETE FROM integration_collections WHERE user_id = $1 AND connection_id = $2', [USER_A, connectionId]);
  });

  it('refuses a sync the grant cannot authorize, naming the scope, without calling the provider', async () => {
    const connection = await query<{ id: string }>('SELECT id FROM provider_connections WHERE user_id = $1 LIMIT 1', [USER_A]);
    const connectionId = connection.rows[0]!.id;

    const refusal = await providerSyncPreflight({ userId: USER_A, connectionId, provider: 'google', feature: 'contacts' });
    expect(refusal).toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED', feature: 'contacts' });
    expect(refusal?.missingScopes).toEqual(['contacts.readonly']);
    const writeRefusal = await providerSyncPreflight({ userId: USER_A, connectionId, provider: 'google', feature: 'contacts', capability: 'write' });
    expect(writeRefusal?.missingScopes).toEqual(['contacts']);
    expect(refusal?.accountId).toBe(accountId);
    expect(refusal?.retryable).toBe(false);

    // The feature the grant does cover passes the preflight.
    await expect(providerSyncPreflight({ userId: USER_A, connectionId, provider: 'google', feature: 'mail' })).resolves.toBeNull();
  });
});

describeOrSkip('the account-to-connection link', () => {
  it('reads the scopes of the connection the account is linked to, not of another one with the same address', async () => {
    // The live symptom: Microsoft mail was authorized and a later calendar consent still read
    // "missing Calendars.ReadWrite". The account was linked to the connection its cutover used, while Graph
    // reported a different `providerUserId` for the same subject, so the address match resolved elsewhere.
    // The link is authoritative; the address is the fallback.
    const linked = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_A, provider: 'google', issuer: 'https://accounts.google.com',
      subject: 'linked-subject', providerUserId: 'other-address@gmail.test',
    }));
    await inTransaction(client => storeOAuthGrant(client, {
      connectionId: linked, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'a', refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: [`${GOOGLE}gmail.modify`, `${GOOGLE}calendar.events`, `${GOOGLE}calendar.calendarlist.readonly`],
      clientIdAtIssue: 'client-1',
    }));
    await query('UPDATE email_accounts SET provider_connection_id = $2 WHERE id = $1', [accountId, linked]);

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    // The linked connection's calendar grant is what the card reports, even though its address differs from
    // the account's own — the identity, not the spelling of the address, decides.
    expect(features!.calendar?.connectionId).toBe(linked);
    expect(features!.calendar?.authorized).toBe(true);
    expect(features!.diagnostics.calendar.authorized).toBe(true);
    expect(features!.diagnostics.calendar.missingScopes).toEqual([]);
  });
});

describeOrSkip('the feature state model', () => {
  it('separates authorization from synchronization, so a failed run is never "not connected"', async () => {
    // The lie the state model removes: a grant exists and the first run failed, and the card said the feature
    // was not connected — which sends the user to reconnect an account that is already authorized.
    const connection = await query<{ id: string }>('SELECT id FROM provider_connections WHERE user_id = $1 LIMIT 1', [USER_A]);
    const connectionId = connection.rows[0]!.id;
    // Start from no recorded run, so "nothing synchronized yet" is the state under test rather than a
    // leftover of the cases above.
    await query('DELETE FROM sync_states WHERE user_id = $1 AND account_id = $2', [USER_A, accountId]);
    await inTransaction(client => storeOAuthGrant(client, {
      connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'a', refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000), scopes: [`${GOOGLE}gmail.modify`], clientIdAtIssue: 'client-1',
    }));

    // Authorized, nothing synchronized yet: pending, not disconnected.
    const beforeRun = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(beforeRun!.mail.authorized).toBe(true);
    expect(beforeRun!.mail.synchronized).toBe(false);
    expect(beforeRun!.mail.syncPending).toBe(true);
    expect(beforeRun!.mail.syncErrorCode).toBeNull();

    // A failed run is reported as a failure with its code, still authorized.
    await inTransaction(async client => {
      const stateId = await ensureSyncState(client, {
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'history',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [stateId],
      );
      await failSyncRun(client, { syncStateId: stateId, generation: Number(lease.rows[0]!.running_generation), errorCode: 'RATE_LIMITED' });
    });
    const failed = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(failed!.mail.authorized).toBe(true);
    expect(failed!.mail.synchronized).toBe(false);
    expect(failed!.mail.syncPending).toBe(true);
    expect(failed!.mail.syncErrorCode).toBe('RATE_LIMITED');

    // A successful run clears the failure and reports the feature as synchronized.
    await inTransaction(async client => {
      const stateId = await ensureSyncState(client, {
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'history',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [stateId],
      );
      await commitSyncCheckpoint(client, { syncStateId: stateId, generation: Number(lease.rows[0]!.running_generation), cursor: 'history-7' });
      await finishSyncRun(client, { syncStateId: stateId, generation: Number(lease.rows[0]!.running_generation), lastErrorCode: null });
    });
    const succeeded = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(succeeded!.mail.synchronized).toBe(true);
    expect(succeeded!.mail.syncPending).toBe(false);
    expect(succeeded!.mail.syncErrorCode).toBeNull();
    // The same three fields exist for the feature groups the interface renders.
    for (const group of [succeeded!.calendar, succeeded!.contacts]) {
      if (group) {
        expect(group).toHaveProperty('synchronized');
        expect(group).toHaveProperty('syncPending');
        expect(group).toHaveProperty('syncErrorCode');
      }
    }
  });
});

describeOrSkip('mail diagnostics read the message pipeline, not discovery', () => {
  it('does not report a label discovery run as a successful mail synchronisation', async () => {
    // The live state was `lastSuccessfulSync` set with `cursorPresent = false`. A Gmail label run records
    // `coverage = 'labels'` and its message/history pipeline records `coverage = 'history'`; reading the newest
    // row for the feature let the discovery run masquerade as synchronisation.
    await query('DELETE FROM sync_states WHERE user_id = $1 AND account_id = $2', [USER_A, accountId]);
    await inTransaction(async client => {
      const labels = await ensureSyncState(client, {
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'labels',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [labels],
      );
      // A discovery run completes without any history cursor: even as a finished run it must not become "mail
      // synchronised", because its coverage is `labels` and only the `history` pipeline counts.
      await commitSyncCheckpoint(client, { syncStateId: labels, generation: Number(lease.rows[0]!.running_generation) });
      await finishSyncRun(client, { syncStateId: labels, generation: Number(lease.rows[0]!.running_generation), lastErrorCode: null });
    });

    const afterDiscovery = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(afterDiscovery!.diagnostics.mail.lastSuccessfulSync).toBeNull();
    expect(afterDiscovery!.diagnostics.mail.cursorPresent).toBe(false);
    expect(afterDiscovery!.mail.synchronized).toBe(false);

    // The message/history pipeline, with its historyId cursor, is what makes mail synchronized.
    await inTransaction(async client => {
      const history = await ensureSyncState(client, {
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'history',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [history],
      );
      await commitSyncCheckpoint(client, { syncStateId: history, generation: Number(lease.rows[0]!.running_generation), cursor: 'history-98765' });
      await finishSyncRun(client, { syncStateId: history, generation: Number(lease.rows[0]!.running_generation), lastErrorCode: null });
    });

    const afterHistory = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(afterHistory!.diagnostics.mail.lastSuccessfulSync).not.toBeNull();
    expect(afterHistory!.diagnostics.mail.cursorPresent).toBe(true);
    expect(afterHistory!.mail.synchronized).toBe(true);
    expect(afterHistory!.mail.syncPending).toBe(false);
  });
});

describeOrSkip('the push model', () => {
  it('separates capability from an active subscription, and never turns polling off', async () => {
    // The live complaint: diagnostics said "Push: available" for a mailbox that was not pushing at all. The
    // capability is the provider's; the subscription is what decides the effective mode.
    const withoutSubscription = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(withoutSubscription!.diagnostics.push.mail.capability).toBe('available');
    expect(withoutSubscription!.diagnostics.push.mail.subscription).toBe('missing');
    expect(withoutSubscription!.diagnostics.push.mail.effectiveSyncMode).toBe('polling');
    // Gmail's contacts have no notification channel, so there is nothing to be subscribed to.
    expect(withoutSubscription!.diagnostics.push.contacts.capability).toBe('unavailable');
    expect(withoutSubscription!.diagnostics.push.contacts.effectiveSyncMode).toBe('polling');

    // An active subscription is what makes it push-and-polling.
    // Against the connection the account is actually linked to, which is the one the diagnostics read.
    const connection = await query<{ provider_connection_id: string | null }>(
      'SELECT provider_connection_id FROM email_accounts WHERE id = $1', [accountId],
    );
    await query(
      `INSERT INTO provider_push_subscriptions
         (user_id, provider_connection_id, provider, resource_type, provider_subscription_id, secret_kind, expires_at, status)
       VALUES ($1, $2, 'google', 'mail', 'sub-1', 'channel_token', NOW() + interval '2 days', 'active')`,
      [USER_A, connection.rows[0]!.provider_connection_id],
    );
    const withSubscription = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(withSubscription!.diagnostics.push.mail.subscription).toBe('active');
    expect(withSubscription!.diagnostics.push.mail.effectiveSyncMode).toBe('push_and_polling');
    // An active subscription is what makes the mail schedule push-and-polling, and nothing is degraded.
    expect(withSubscription!.diagnostics.push.mail.degradedReason).toBeNull();
    expect(withSubscription!.diagnostics.push.mail.expiresAt).not.toBeNull();
    expect(withSubscription!.diagnostics.mail.scheduler).toBe('scheduled_and_push');

    // A subscription that exists but is not delivering says why, instead of being collapsed into "missing".
    await query("UPDATE provider_push_subscriptions SET status = 'failed', last_error_code = 'RENEWAL_REJECTED' WHERE provider_subscription_id = 'sub-1'");
    const failed = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(failed!.diagnostics.push.mail.subscription).toBe('failed');
    expect(failed!.diagnostics.push.mail.degradedReason).toBe('subscription_failed');
    expect(failed!.diagnostics.push.mail.lastErrorCode).toBe('RENEWAL_REJECTED');
    expect(failed!.diagnostics.mail.scheduler).toBe('scheduled');

    // An expired subscription falls back to polling rather than reporting a push that is not there.
    await query("UPDATE provider_push_subscriptions SET status = 'expired' WHERE provider_subscription_id = 'sub-1'");
    const expired = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(expired!.diagnostics.push.mail.subscription).toBe('expired');
    expect(expired!.diagnostics.push.mail.effectiveSyncMode).toBe('polling');
    expect(expired!.diagnostics.push.mail.degradedReason).toBe('subscription_expired');

    await query("DELETE FROM provider_push_subscriptions WHERE provider_subscription_id = 'sub-1'");
  });
});

describeOrSkip('how a feature is refreshed', () => {
  it('says which coverage it read and whether the scheduler would refresh it', async () => {
    // "Last synchronised: never" is only useful with the reason beside it: a feature that is no scheduler
    // target is refreshed by a manual run alone, and that is worth reporting rather than leaving to be guessed.
    await query('DELETE FROM integration_collections WHERE user_id = $1', [USER_A]);
    const unscheduled = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(unscheduled!.diagnostics.mail.syncStateCoverage).toBe('history');
    expect(unscheduled!.diagnostics.mail.schedulerTarget).toBe(false);

    // A Gmail label collection linked to a local folder is what the scheduler query accepts.
    const connection = await query<{ provider_connection_id: string | null }>(
      'SELECT provider_connection_id FROM email_accounts WHERE id = $1', [accountId],
    );
    const folder = await query<{ id: string }>(
      "INSERT INTO folders (account_id, name, path) VALUES ($1, 'INBOX', 'INBOX') RETURNING id", [accountId],
    );
    await query(
      `INSERT INTO integration_collections (user_id, connection_id, account_id, kind, remote_id, local_folder_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, $3, 'mail_label', 'INBOX', $4, true, 'read_only', 'source', 'off')`,
      [USER_A, connection.rows[0]!.provider_connection_id, accountId, folder.rows[0]!.id],
    );

    const scheduled = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(scheduled!.diagnostics.mail.schedulerTarget).toBe(true);
    // The coverage is the pipeline's, not the discovery row's, whatever collections exist.
    expect(scheduled!.diagnostics.mail.syncStateCoverage).toBe('history');
    expect(scheduled!.diagnostics.calendar.syncStateCoverage).toBe('events');
    expect(scheduled!.diagnostics.contacts.syncStateCoverage).toBe('personal');
    // Calendar has no collection of its own here, so it is authorized-but-unscheduled rather than assumed.
    expect(scheduled!.diagnostics.calendar.schedulerTarget).toBe(false);

    await query('DELETE FROM integration_collections WHERE user_id = $1', [USER_A]);
  });
});

describeOrSkip('calendar and address-book state is read from where it is stored', () => {
  it('counts calendars and address books by kind and reads the calendar pipeline run', async () => {
    // OBS-01: the sync writers store calendar state as feature 'calendars' and contacts state as 'contacts',
    // both with a connection and a collection but no account id, while calendar and address-book collections
    // likewise carry only a connection. A reader that filtered on account_id and on the raw feature name saw
    // none of it: the card reported "last synchronisation: never" and "0 address books" beside a connection
    // that had in fact pulled both.
    await query('DELETE FROM integration_collections WHERE user_id = $1', [USER_A]);
    await query('DELETE FROM sync_states WHERE user_id = $1', [USER_A]);

    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_A, provider: 'google', issuer: 'https://accounts.google.com',
      subject: 'diag-obs01', providerUserId: 'diag@gmail.test',
    }));
    await query('UPDATE email_accounts SET provider_connection_id = $2 WHERE id = $1', [accountId, connectionId]);
    // Every feature authorized, so an unscheduled/never result cannot be blamed on a missing scope.
    await inTransaction(client => storeOAuthGrant(client, {
      connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'a', refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: [`${GOOGLE}gmail.modify`, `${GOOGLE}calendar.events`, `${GOOGLE}contacts`],
      clientIdAtIssue: 'client-1',
    }));

    const primary = await query<{ id: string }>(
      "INSERT INTO calendars (user_id, name, owner_user_id) VALUES ($1, 'Primary', $1) RETURNING id", [USER_A],
    );
    const team = await query<{ id: string }>(
      "INSERT INTO calendars (user_id, name, owner_user_id) VALUES ($1, 'Team', $1) RETURNING id", [USER_A],
    );
    const book = await query<{ id: string }>(
      "INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal') RETURNING id", [USER_A],
    );
    // Collections exactly as the sync writers create them: calendar and address_book rows have no account_id.
    await query(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_calendar_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, 'calendar', 'primary', $3, true, 'read_write', 'source', 'off'),
              ($1, $2, 'calendar', 'team', $4, true, 'read_only', 'source', 'off')`,
      [USER_A, connectionId, primary.rows[0]!.id, team.rows[0]!.id],
    );
    await query(
      `INSERT INTO integration_collections
         (user_id, connection_id, kind, remote_id, local_address_book_id, enabled, source_access, user_access, dav_mode)
       VALUES ($1, $2, 'address_book', 'personal', $3, true, 'read_write', 'source', 'off')`,
      [USER_A, connectionId, book.rows[0]!.id],
    );

    await query(
      `INSERT INTO sync_states (user_id, connection_id, feature, collection_id, coverage, last_success_at, cursor)
       SELECT $1, $2, 'calendars', ic.id, 'events', NOW() - interval '1 hour', 'cursor-cal'
         FROM integration_collections ic
        WHERE ic.user_id = $1 AND ic.kind = 'calendar'`,
      [USER_A, connectionId],
    );
    await query(
      `INSERT INTO sync_states (user_id, connection_id, feature, collection_id, coverage, last_success_at, cursor)
       SELECT $1, $2, 'contacts', ic.id, 'personal', NOW() - interval '2 hours', 'cursor-book'
         FROM integration_collections ic
        WHERE ic.user_id = $1 AND ic.kind = 'address_book'`,
      [USER_A, connectionId],
    );

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.calendar.collections).toBe(2);
    expect(features!.diagnostics.contacts.collections).toBe(1);
    expect(features!.calendar!.collections).toHaveLength(2);
    expect(features!.contacts!.collections).toHaveLength(1);
    expect(features!.diagnostics.calendar.lastSuccessfulSync).not.toBeNull();
    expect(features!.diagnostics.calendar.cursorPresent).toBe(true);
    expect(features!.diagnostics.calendar.syncStateCoverage).toBe('events');
    expect(features!.diagnostics.contacts.lastSuccessfulSync).not.toBeNull();
    expect(features!.diagnostics.contacts.syncStateCoverage).toBe('personal');
    // A linked calendar or address-book collection is a scheduler target even without an account id on it.
    expect(features!.diagnostics.calendar.schedulerTarget).toBe(true);
    expect(features!.diagnostics.contacts.schedulerTarget).toBe(true);

    await query('DELETE FROM integration_collections WHERE user_id = $1', [USER_A]);
    await query('DELETE FROM sync_states WHERE user_id = $1', [USER_A]);
  });

  it('names the Microsoft mail coverage for a Microsoft account, not the Google one', async () => {
    // A single shared coverage string reported `history` for a Graph mailbox, whose pipeline is `messages`
    // (OBS-01). The name is what the interface shows, so it has to follow the provider that owns the feature.
    const microsoftAccount = await query<{ id: string }>(
      `INSERT INTO email_accounts (user_id, name, email_address, imap_host, imap_port, smtp_host, smtp_port, auth_user, auth_pass, mail_transport)
       VALUES ($1, 'Graph', 'diag@outlook.test', 'outlook.office365.com', 993, 'smtp.office365.com', 587, 'diag@outlook.test', 'x', 'microsoft_graph')
       RETURNING id`,
      [USER_A],
    );
    const microsoftAccountId = microsoftAccount.rows[0]!.id;
    await query('DELETE FROM sync_states WHERE user_id = $1 AND account_id = $2', [USER_A, microsoftAccountId]);
    await query(
      `INSERT INTO sync_states (user_id, account_id, feature, coverage, last_success_at, cursor)
       VALUES ($1, $2, 'mail', 'messages', NOW(), 'delta-1')`,
      [USER_A, microsoftAccountId],
    );

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId: microsoftAccountId });
    expect(features!.provider).toBe('microsoft');
    expect(features!.diagnostics.mail.syncStateCoverage).toBe('messages');
    expect(features!.diagnostics.mail.lastSuccessfulSync).not.toBeNull();

    await query('DELETE FROM sync_states WHERE user_id = $1 AND account_id = $2', [USER_A, microsoftAccountId]);
    await query('DELETE FROM email_accounts WHERE id = $1', [microsoftAccountId]);
  });

  it('exposes lifecycle authorization only on the owned account calendar without changing event capabilities', async () => {
    const connectionId = await inTransaction(client => upsertProviderConnection(client, {
      userId: USER_A, provider: 'google', issuer: 'https://accounts.google.com',
      subject: 'diag-lifecycle-subject', providerUserId: 'diag@gmail.test',
    }));
    await query('UPDATE email_accounts SET provider_connection_id = $2 WHERE id = $1', [accountId, connectionId]);
    const events = [`${GOOGLE}calendar.calendarlist.readonly`, `${GOOGLE}calendar.events`];
    for (const managementScope of [null, 'calendar.calendars', 'calendar']) {
      await inTransaction(client => storeOAuthGrant(client, {
        connectionId, audience: GOOGLE_GRANT_AUDIENCE, accessToken: 'a', refreshToken: null,
        expiresAt: new Date(Date.now() + 3600_000), scopes: [...events, ...(managementScope ? [`${GOOGLE}${managementScope}`] : [])], clientIdAtIssue: 'client-1',
      }));
      const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
      expect(features?.calendar).toMatchObject({
        connectionId, authorized: true, canDiscover: true, canRead: true, canWrite: true,
        calendarManagement: {
          authorized: managementScope !== null,
          requiredScopes: [managementScope ?? 'calendar.calendars'],
          missingScopes: managementScope ? [] : ['calendar.calendars'],
        },
      });
      expect(features?.mail).not.toHaveProperty('calendarManagement');
      expect(features?.contacts).not.toHaveProperty('calendarManagement');
      expect(features?.contacts?.canWrite).toBe(false);
      expect(await describeAccountProviderFeatures({ userId: USER_B, accountId })).toBeNull();
    }
    await query("UPDATE oauth_grants SET status = 'revoked' WHERE connection_id = $1", [connectionId]);
    const revoked = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(revoked?.calendar?.calendarManagement).toMatchObject({ authorized: false, missingScopes: ['calendar.calendars'] });
  });
});
