// Real PostgreSQL tests for the Microsoft Graph contacts sync (P07/P09). The
// provider is faked at the HTTP boundary; discovery, the remote link, the vCard
// projection, the lease, the delta cursor and the baseline reconciliation are real.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/microsoft/graphContactsSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db.js';
import {
  MICROSOFT_GRANT_AUDIENCE,
  MICROSOFT_ISSUER,
  storeOAuthGrant,
  upsertProviderConnection,
} from '../../providerAuthService.js';
import { acquireSyncLease, ensureSyncState } from '../../syncCoordinator.js';
import { syncGraphContacts } from './graphContactsSync.js';
import type { GraphContact } from './graphContacts.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004a1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common' };
const originalKey = process.env.ENCRYPTION_KEY;
const DELTA_BASE = 'https://graph.microsoft.com/v1.0/me/contactFolders/contacts/contacts/delta';

const contact = (id: string, displayName: string, email: string): GraphContact => ({
  id,
  displayName,
  givenName: displayName.split(' ')[0],
  surname: displayName.split(' ').slice(1).join(' '),
  emailAddresses: [{ address: email, name: displayName }],
  businessPhones: ['+48 22 000 00 00'],
  companyName: 'Analytical Engines',
});

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response;
}

function fakeProvider(handlers: Array<(url: string) => Response | Promise<Response>>) {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(url);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls };
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

async function seedConnection(): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject: 'ms-sub-contacts',
    });
    await storeOAuthGrant(client, {
      connectionId,
      audience: MICROSOFT_GRANT_AUDIENCE,
      accessToken: 'graph-access-valid',
      refreshToken: 'graph-refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['https://graph.microsoft.com/Contacts.ReadWrite'],
      clientIdAtIssue: CONFIG.clientId,
    });
    return connectionId;
  });
}

async function storedContacts(): Promise<Array<{ uid: string; display_name: string; primary_email: string; vcard: string }>> {
  const result = await autocommit(client => client.query<{ uid: string; display_name: string; primary_email: string; vcard: string }>(
    'SELECT uid, display_name, primary_email, vcard FROM contacts WHERE user_id = $1 ORDER BY uid', [USER_ID],
  ));
  return result.rows;
}

describeOrSkip('Microsoft Graph contacts sync (PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    await autocommit(client => client.query(
      `INSERT INTO users (id, username) VALUES ($1, 'graph-contacts-user') ON CONFLICT (id) DO NOTHING`,
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

  it('creates one hidden book and projects the contacts from a baseline delta', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({
        value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test'), contact('c2', 'Grace Hopper', 'grace@contoso.test')],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=baseline`,
      }),
    ]);

    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ created: 2, updated: 0, deleted: 0, fullSync: true, cursor: `${DELTA_BASE}?$deltatoken=baseline` });
    expect(provider.urls[0]).toContain('/me/contactFolders/contacts/contacts/delta');

    const book = await autocommit(client => client.query<{ source: string; dav_mode: string }>(
      'SELECT source, dav_mode FROM address_books WHERE user_id = $1', [USER_ID],
    ));
    expect(book.rows[0]).toMatchObject({ source: 'microsoft', dav_mode: 'off' });

    const contacts = await storedContacts();
    expect(contacts.map(row => row.uid)).toEqual(['msgraph-c1', 'msgraph-c2']);
    expect(contacts[0]?.display_name).toBe('Ada Lovelace');
    expect(contacts[0]?.primary_email).toBe('ada@contoso.test');
    expect(contacts[0]?.vcard).toContain('UID:msgraph-c1');
    expect(contacts[0]?.vcard).toContain('ORG:Analytical Engines');

    const state = await autocommit(client => client.query<{ cursor: string | null; last_success_at: Date | null; last_error_code: string | null }>(
      'SELECT cursor, last_success_at, last_error_code FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    expect(state.rows[0]?.cursor).toBe(`${DELTA_BASE}?$deltatoken=baseline`);
    // The connector status the UI reads is this bookkeeping.
    expect(state.rows[0]?.last_success_at).not.toBeNull();
    expect(state.rows[0]?.last_error_code).toBeNull();

    // The next run sends the stored delta link back, exactly as Graph issued it.
    const incremental = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=delta-2` }),
    ]);
    const second = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: incremental.fetchImpl });
    expect(second).toMatchObject({ created: 0, updated: 1, fullSync: false, cursor: `${DELTA_BASE}?$deltatoken=delta-2` });
    expect(incremental.urls[0]).toBe(`${DELTA_BASE}?$deltatoken=baseline`);
  });

  it('stores the anniversary and IM addresses a Graph contact carries', async () => {
    // The mirror of the Google case: the mapper's fields are verified by reading and by unit tests,
    // and this is the proof that the columns are written.
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({
        value: [{
          ...contact('c9', 'Ada Lovelace', 'ada@contoso.test'),
          birthday: '1815-12-10T00:00:00Z',
          anniversary: '1835-07-08T00:00:00Z',
          imAddresses: ['ada@jabber.example', ''],
        }],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=fields`,
      }),
    ]);

    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });

    // DATE columns come back as Date objects unless cast, which is the mistake the Google case made
    // first; comparing text is comparing the data rather than the driver.
    const stored = await autocommit(client => client.query<{
      birthday: string | null; anniversary: string | null; instant_messages: Array<{ value: string; type: string }>;
    }>('SELECT birthday::text AS birthday, anniversary::text AS anniversary, instant_messages FROM contacts WHERE user_id = $1', [USER_ID]));
    expect(stored.rows[0]).toMatchObject({
      birthday: '1815-12-10',
      anniversary: '1835-07-08',
      // A bare Graph IM address has no protocol, so it is typed `other`, and the empty entry is gone.
      instant_messages: [{ value: 'ada@jabber.example', type: 'other' }],
    });
  });

  it('removes a contact the delta reports as deleted, keeping a tombstone link', async () => {
    const connectionId = await seedConnection();
    await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({
        value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test'), contact('c2', 'Grace Hopper', 'grace@contoso.test')],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=baseline`,
      })]).fetchImpl,
    });

    const deletion = fakeProvider([
      () => json({ value: [{ id: 'c1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=delta-2` }),
    ]);
    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: deletion.fetchImpl });
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 1, fullSync: false });

    expect((await storedContacts()).map(row => row.uid)).toEqual(['msgraph-c2']);
    const link = await autocommit(client => client.query<{ status: string; local_id: string | null }>(
      `SELECT status, local_id FROM remote_object_links WHERE user_id = $1 AND object_remote_id = 'c1'`, [USER_ID],
    ));
    expect(link.rows[0]).toMatchObject({ status: 'deleted', local_id: null });
  });

  it('rebuilds after an expired delta token and reconciles what the baseline no longer lists', async () => {
    const connectionId = await seedConnection();
    await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({
        value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test'), contact('c2', 'Grace Hopper', 'grace@contoso.test')],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=stale`,
      })]).fetchImpl,
    });

    const provider = fakeProvider([
      // The stored delta token is no longer accepted.
      () => json({ error: { code: 'syncStateNotFound', message: 'delta token expired' } }, 410),
      // The baseline no longer lists c2: it was deleted while the token was unusable.
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=fresh` }),
    ]);
    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ fullSync: true, deleted: 1, cursor: `${DELTA_BASE}?$deltatoken=fresh` });
    expect(provider.urls[1]).not.toContain('$deltatoken=stale');

    // A plain re-read would have left the deleted contact behind; reconciliation removes it.
    expect((await storedContacts()).map(row => row.uid)).toEqual(['msgraph-c1']);
    const link = await autocommit(client => client.query<{ status: string }>(
      `SELECT status FROM remote_object_links WHERE user_id = $1 AND object_remote_id = 'c2'`, [USER_ID],
    ));
    expect(link.rows[0]?.status).toBe('deleted');
  });

  it('records the failure time and code when a run fails after taking the lease', async () => {
    const connectionId = await seedConnection();
    // The first page succeeds, the second fails: the run throws after the lease was taken,
    // so this is the path that records the failure the status line reports.
    const provider = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.nextLink': `${DELTA_BASE}?$skiptoken=page-2` }),
      () => json({ error: { code: 'ErrorInternalServerError', message: 'server error' } }, 500),
    ]);

    await expect(syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl }))
      .rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const state = await autocommit(client => client.query<{ last_error_code: string | null; last_error_at: Date | null }>(
      'SELECT last_error_code, last_error_at FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    // Both fields, because the status line shows the code *and* when it happened.
    expect(state.rows[0]?.last_error_code).toBe('UPSTREAM_UNAVAILABLE');
    expect(state.rows[0]?.last_error_at).not.toBeNull();
  });

  it('refuses a second concurrent sync for the same connection', async () => {
    const connectionId = await seedConnection();
    await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ value: [], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=empty` })]).fetchImpl,
    });

    const collection = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM integration_collections WHERE user_id = $1 AND kind = 'address_book'`, [USER_ID],
    ));
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_ID, connectionId, feature: 'contacts', collectionId: collection.rows[0]?.id ?? null, coverage: 'personal',
    }));
    expect(await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'other-worker' }))).not.toBeNull();

    await expect(syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ value: [] })]).fetchImpl,
    })).rejects.toMatchObject({ name: 'GraphApiError', code: 'RATE_LIMITED' });
  });
});
