// Real PostgreSQL tests for the Google People contacts sync (P09, read path).
// The provider is faked at the HTTP boundary; everything else — discovery, the
// remote link, the vCard projection, the lease and the sync cursor — is real.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/google/googleContactsSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import { GOOGLE_GRANT_AUDIENCE, GOOGLE_ISSUER, storeOAuthGrant, upsertProviderConnection } from '../../providerAuthService.js';
import { acquireSyncLease, ensureSyncState } from '../../syncCoordinator.js';
import { syncGoogleContacts } from './googleContactsSync.js';
import type { GooglePerson } from './googlePeople.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000003e1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/oauth/google/callback' };
const originalKey = process.env.ENCRYPTION_KEY;

const person = (resourceName: string, displayName: string, email: string): GooglePerson => ({
  resourceName,
  etag: `etag-${resourceName}`,
  names: [{ displayName, givenName: displayName.split(' ')[0], familyName: displayName.split(' ').slice(1).join(' '), metadata: { primary: true } }],
  emailAddresses: [{ value: email, type: 'work', metadata: { primary: true } }],
  phoneNumbers: [{ value: '+48 600 000 000', type: 'mobile' }],
});

/** A fake People API: one handler per request, with the URLs recorded. */
function fakeProvider(handlers: Array<() => Response | Promise<Response>>) {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler();
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body } as Response;
}

async function autocommit<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

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

async function seedConnection(input: { expiresAt?: Date } = {}): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'google', issuer: GOOGLE_ISSUER, subject: 'sub-contacts',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: GOOGLE_GRANT_AUDIENCE,
      accessToken: 'access-valid',
      refreshToken: 'refresh-1',
      expiresAt: input.expiresAt ?? new Date(Date.now() + 3600_000),
      scopes: ['https://www.googleapis.com/auth/contacts'],
      clientIdAtIssue: CONFIG.clientId,
    });
    return connectionId;
  });
}

describeOrSkip('Google contacts sync (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'google-contacts-user') ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    ));
  });

  afterAll(async () => {
    await autocommit(client => client.query('DELETE FROM users WHERE id = $1', [USER_ID]));
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    await autocommit(async client => {
      await client.query('DELETE FROM provider_connections WHERE user_id = $1', [USER_ID]);
      await client.query('DELETE FROM address_books WHERE user_id = $1', [USER_ID]);
    });
  });

  it('creates one hidden address book and projects every connected person', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({ connections: [person('people/c1', 'Ada Lovelace', 'ada@example.test'), person('people/c2', 'Grace Hopper', 'grace@example.test')], nextPageToken: 'page-2' }),
      () => json({ connections: [person('people/c3', 'Alan Turing', 'alan@example.test')], nextSyncToken: 'sync-1' }),
    ]);

    const result = await syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ created: 3, updated: 0, deleted: 0, fullSync: true, cursor: 'sync-1' });

    // The first page starts a sync; the second continues it and carries the token.
    expect(provider.urls[0]).toContain('requestSyncToken=true');
    expect(provider.urls[1]).toContain('pageToken=page-2');
    expect(provider.urls[1]).not.toContain('requestSyncToken');

    const book = await autocommit(client => client.query<{ id: string; source: string; dav_mode: string }>(
      'SELECT id, source, dav_mode FROM address_books WHERE user_id = $1', [USER_ID],
    ));
    expect(book.rows[0]).toMatchObject({ source: 'google', dav_mode: 'off' });

    const contacts = await autocommit(client => client.query<{ display_name: string; primary_email: string; vcard: string; uid: string }>(
      'SELECT display_name, primary_email, vcard, uid FROM contacts WHERE user_id = $1 ORDER BY display_name', [USER_ID],
    ));
    expect(contacts.rows.map(row => row.display_name)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(contacts.rows[0]?.primary_email).toBe('ada@example.test');
    // Identity comes from the resource name, and the vCard carries it as the UID.
    expect(contacts.rows[0]?.uid).toBe('google-c1');
    expect(contacts.rows[0]?.vcard).toContain('UID:google-c1');

    const state = await autocommit(client => client.query<{ cursor: string | null; last_success_at: Date | null; last_error_code: string | null }>(
      'SELECT cursor, last_success_at, last_error_code FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    expect(state.rows[0]?.cursor).toBe('sync-1');
    // The connector status the UI reads is this bookkeeping: a successful run must leave
    // a success time and clear the error, or the status line silently shows nothing.
    expect(state.rows[0]?.last_success_at).not.toBeNull();
    expect(state.rows[0]?.last_error_code).toBeNull();

    // A second run reconciles against the stored cursor without asking for a new token.
    const incremental = fakeProvider([
      () => json({ connections: [person('people/c1', 'Ada Lovelace', 'ada@example.test')], nextSyncToken: 'sync-2' }),
    ]);
    const second = await syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: incremental.fetchImpl });
    expect(second).toMatchObject({ created: 0, updated: 1, fullSync: false, cursor: 'sync-2' });
    expect(incremental.urls[0]).toContain('syncToken=sync-1');
    expect(incremental.urls[0]).not.toContain('requestSyncToken');
  });

  it('does not switch a disabled collection back on when it refreshes', async () => {
    // Only the connector status and the schedule read `enabled`, and the schedule honours
    // it. A refresh re-asserting it would silently undo a disable at the next run.
    const connectionId = await seedConnection();
    await syncGoogleContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ connections: [], nextSyncToken: 'sync-1' })]).fetchImpl,
    });
    await autocommit(client => client.query(
      `UPDATE integration_collections SET enabled = false WHERE user_id = $1 AND kind = 'address_book'`, [USER_ID],
    ));

    const second = await syncGoogleContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ connections: [], nextSyncToken: 'sync-2' })]).fetchImpl,
    });
    expect(second.fullSync).toBe(false);

    const state = await autocommit(client => client.query<{ enabled: boolean }>(
      `SELECT enabled FROM integration_collections WHERE user_id = $1 AND kind = 'address_book'`, [USER_ID],
    ));
    expect(state.rows[0]?.enabled).toBe(false);
  });

  it('records the provider code for a revoked consent instead of an internal error', async () => {
    // The token service throws its own error type, and the adapters used to record
    // anything they did not recognise as INTERNAL_ERROR — so the one failure a user can
    // act on (reconnect the account) was reported as an internal fault and the message
    // written for it never appeared.
    const connectionId = await seedConnection({ expiresAt: new Date(Date.now() - 60_000) });
    const provider = fakeProvider([
      () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    ]);

    await expect(syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_grant' });

    const state = await autocommit(client => client.query<{ last_error_code: string | null }>(
      'SELECT last_error_code FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    expect(state.rows[0]?.last_error_code).toBe('invalid_grant');
  });

  it('removes a person the provider reports as deleted, keeping the link as a tombstone', async () => {
    const connectionId = await seedConnection();
    await syncGoogleContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ connections: [person('people/c1', 'Ada Lovelace', 'ada@example.test'), person('people/c2', 'Grace Hopper', 'grace@example.test')], nextSyncToken: 'sync-1' })]).fetchImpl,
    });

    const deletion = fakeProvider([
      () => json({ connections: [{ resourceName: 'people/c1', metadata: { deleted: true } }], nextSyncToken: 'sync-2' }),
    ]);
    const result = await syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: deletion.fetchImpl });
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 1 });

    const contacts = await autocommit(client => client.query<{ uid: string }>('SELECT uid FROM contacts WHERE user_id = $1', [USER_ID]));
    expect(contacts.rows.map(row => row.uid)).toEqual(['google-c2']);
    const link = await autocommit(client => client.query<{ status: string; local_id: string | null }>(
      `SELECT status, local_id FROM remote_object_links WHERE user_id = $1 AND object_remote_id = 'people/c1'`, [USER_ID],
    ));
    expect(link.rows[0]).toMatchObject({ status: 'deleted', local_id: null });
  });

  it('rebuilds from a fresh baseline when the provider rejects the stored cursor', async () => {
    const connectionId = await seedConnection();
    await syncGoogleContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ connections: [person('people/c1', 'Ada Lovelace', 'ada@example.test')], nextSyncToken: 'stale-1' })]).fetchImpl,
    });

    const provider = fakeProvider([
      // The stored cursor is no longer accepted (history was lost).
      () => json({ error: { message: 'Sync token is no longer valid', status: 'FAILED_PRECONDITION' } }, 410),
      // The retry is a fresh baseline and must not delete the local projection first.
      () => json({ connections: [person('people/c1', 'Ada Lovelace', 'ada@example.test'), person('people/c9', 'New Person', 'new@example.test')], nextSyncToken: 'fresh-1' }),
    ]);
    const result = await syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ fullSync: true, created: 1, cursor: 'fresh-1' });
    expect(provider.urls[1]).toContain('requestSyncToken=true');

    const contacts = await autocommit(client => client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts WHERE user_id = $1', [USER_ID]));
    expect(contacts.rows[0]?.count).toBe('2');
  });

  it('refuses a second concurrent sync for the same connection', async () => {
    const connectionId = await seedConnection();
    await syncGoogleContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ connections: [], nextSyncToken: 'sync-1' })]).fetchImpl,
    });

    const collection = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM integration_collections WHERE user_id = $1 AND kind = 'address_book'`, [USER_ID],
    ));
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_ID, connectionId, feature: 'contacts', collectionId: collection.rows[0]?.id ?? null, coverage: 'personal',
    }));
    const held = await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'other-worker' }));
    expect(held).not.toBeNull();

    await expect(syncGoogleContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([() => json({})]).fetchImpl }))
      .rejects.toMatchObject({ name: 'GoogleApiError', code: 'RATE_LIMITED' });
  });
});
