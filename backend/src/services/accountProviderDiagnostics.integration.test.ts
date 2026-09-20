import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from './db.js';
import { GOOGLE_GRANT_AUDIENCE, storeOAuthGrant, upsertProviderConnection } from './providerAuthService.js';
import { describeAccountProviderFeatures } from './accountProviderFeatures.js';
import { providerSyncPreflight } from './providerSyncDiagnostics.js';
import { commitSyncCheckpoint, ensureSyncState, failSyncRun } from './syncCoordinator.js';

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
        userId: USER_A, connectionId: null, accountId, feature: 'mail', collectionId: null, coverage: 'default',
      });
      const lease = await client.query<{ running_generation: string | number }>(
        'UPDATE sync_states SET running_generation = COALESCE(running_generation, 0) + 1, lease_expires_at = NOW() + interval \'5 minutes\' WHERE id = $1 RETURNING running_generation',
        [id],
      );
      const leaseGeneration = Number(lease.rows[0]!.running_generation);
      await commitSyncCheckpoint(client, { syncStateId: id, generation: leaseGeneration, cursor: 'history-42' });
      await failSyncRun(client, { syncStateId: id, generation: leaseGeneration, errorCode: 'RATE_LIMITED' });
      return { syncStateId: id };
    });
    expect(syncStateId).toBeTruthy();

    const features = await describeAccountProviderFeatures({ userId: USER_A, accountId });
    expect(features!.diagnostics.mail.lastSuccessfulSync).not.toBeNull();
    expect(features!.diagnostics.mail.lastErrorCode).toBe('RATE_LIMITED');
    expect(features!.diagnostics.mail.cursorPresent).toBe(true);
    expect(features!.diagnostics.mail.transport).toBe('gmail_api');
    expect(features!.diagnostics.mail.scheduler).toBe('scheduled_and_push');
    // A feature with no recorded run says so instead of inventing a time.
    expect(features!.diagnostics.calendar.lastSuccessfulSync).toBeNull();
    expect(features!.diagnostics.calendar.lastErrorCode).toBeNull();
  });

  it('refuses a sync the grant cannot authorize, naming the scope, without calling the provider', async () => {
    const connection = await query<{ id: string }>('SELECT id FROM provider_connections WHERE user_id = $1 LIMIT 1', [USER_A]);
    const connectionId = connection.rows[0]!.id;

    const refusal = await providerSyncPreflight({ userId: USER_A, connectionId, provider: 'google', feature: 'contacts' });
    expect(refusal).toMatchObject({ code: 'PROVIDER_AUTH_REQUIRED', feature: 'contacts' });
    expect(refusal?.missingScopes).toEqual(['contacts']);
    expect(refusal?.accountId).toBe(accountId);
    expect(refusal?.retryable).toBe(false);

    // The feature the grant does cover passes the preflight.
    await expect(providerSyncPreflight({ userId: USER_A, connectionId, provider: 'google', feature: 'mail' })).resolves.toBeNull();
  });
});
