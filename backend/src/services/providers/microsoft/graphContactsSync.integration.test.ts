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
import { DEFAULT_GRAPH_CONTACTS_TARGET, type GraphContact } from './graphContacts.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const USER_ID = '00000000-0000-0000-0000-0000000004a1';
const CONFIG = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', providerRedirectUri: 'https://x/oauth/provider/microsoft/callback', tenantId: 'common' };
const originalKey = process.env.ENCRYPTION_KEY;
/**
 * The contact folder the fake provider lists, and the delta base built from its **real** id.
 *
 * GRAPH-03: the sync discovers the folder instead of addressing it as the literal `contacts`, so every case here
 * needs the discovery answered. It is answered by the fake below rather than by a handler, so the handlers stay
 * about the delta each case is exercising.
 */
const FOLDER_ID = 'AAMkAD-contact-folder-1';
const DELTA_BASE = `https://graph.microsoft.com/v1.0/me/contactFolders/${FOLDER_ID}/contacts/delta`;
/** The same delta endpoint for another folder, so a case with several folders can name each one. */
const delataBaseFor = (folderId: string): string =>
  `https://graph.microsoft.com/v1.0/me/contactFolders/${folderId}/contacts/delta`;

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

interface FakeFolder { id: string; displayName: string | null; parentFolderId: string | null }

function fakeProvider(
  handlers: Array<(url: string) => Response | Promise<Response>>,
  /**
   * The mailbox the fake lists. The default is one top-level folder with no children, which is what most cases
   * need; a case about several folders passes its own.
   */
  folders: FakeFolder[] = [{ id: FOLDER_ID, displayName: 'Contacts', parentFolderId: null }],
) {
  const urls: string[] = [];
  const discoveryUrls: string[] = [];
  const defaultUrls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    const target = String(url);
    // The folder discovery is scaffolding for every case, so it is answered here and recorded separately: the
    // `urls` list stays the sequence of delta requests the case is about.
    if (target.includes('/childFolders')) {
      discoveryUrls.push(target);
      const parentId = decodeURIComponent(/contactFolders\/([^/]+)\/childFolders/.exec(target)?.[1] ?? '');
      return json({ value: folders.filter(folder => folder.parentFolderId === parentId) });
    }
    if (target.includes('/me/contactFolders?')) {
      discoveryUrls.push(target);
      return json({ value: folders.filter(folder => !folder.parentFolderId) });
    }
    // The default collection is independent from a folder. Existing cases exercise
    // folder deltas; give the new default path an explicit empty complete baseline
    // without consuming their folder-specific handler sequence.
    if (target.includes('/me/contacts?')) {
      defaultUrls.push(target);
      return json({ value: [] });
    }
    urls.push(target);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(target);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, discoveryUrls, defaultUrls };
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

  it('creates independent hidden books and projects the contacts from a folder baseline delta', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({
        value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test'), contact('c2', 'Grace Hopper', 'grace@contoso.test')],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=baseline`,
      }),
    ]);

    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ created: 2, updated: 0, deleted: 0, fullSync: true, cursor: null });
    expect(result.books).toHaveLength(2);
    expect(result.books[1]).toMatchObject({ created: 2, cursor: `${DELTA_BASE}?$deltatoken=baseline` });
    expect(provider.defaultUrls).toHaveLength(1);
    // The folders were discovered — the top-level list and this mailbox's (empty) child list — and the delta
    // named the **real** folder id it returned: the literal `contacts` this used to send is not a folder id Graph
    // resolves (GRAPH-03).
    expect(provider.discoveryUrls).toHaveLength(2);
    expect(provider.discoveryUrls[0]).toContain('/me/contactFolders?');
    expect(provider.discoveryUrls[1]).toContain(`/me/contactFolders/${FOLDER_ID}/childFolders`);
    expect(provider.urls[0]).toContain(`/me/contactFolders/${FOLDER_ID}/contacts/delta`);

    const book = await autocommit(client => client.query<{ source: string; dav_mode: string }>(
      'SELECT source, dav_mode FROM address_books WHERE user_id = $1', [USER_ID],
    ));
    expect(book.rows[0]).toMatchObject({ source: 'microsoft', dav_mode: 'off' });

    // The collection records what the **grant** permits, not a blanket read-only: the connection above was
    // authorized with `Contacts.ReadWrite`, so the write-back switch can be offered. `user_access` stays
    // `source` — enabling it remains the user's own decision.
    const collection = await autocommit(client => client.query<{ source_access: string; user_access: string }>(
      'SELECT source_access, user_access FROM integration_collections WHERE user_id = $1', [USER_ID],
    ));
    expect(collection.rows[0]).toEqual({ source_access: 'read_write', user_access: 'source' });

    const contacts = await storedContacts();
    expect(contacts.map(row => row.uid)).toEqual(['msgraph-c1', 'msgraph-c2']);
    expect(contacts[0]?.display_name).toBe('Ada Lovelace');
    expect(contacts[0]?.primary_email).toBe('ada@contoso.test');
    expect(contacts[0]?.vcard).toContain('UID:msgraph-c1');
    expect(contacts[0]?.vcard).toContain('ORG:Analytical Engines');

    const state = await autocommit(client => client.query<{ cursor: string | null; last_success_at: Date | null; last_error_code: string | null }>(
      'SELECT cursor, last_success_at, last_error_code FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    expect(state.rows.some(row => row.cursor === `${DELTA_BASE}?$deltatoken=baseline`)).toBe(true);
    // The connector status the UI reads is this bookkeeping.
    expect(state.rows[0]?.last_success_at).not.toBeNull();
    expect(state.rows[0]?.last_error_code).toBeNull();

    // The next run sends the stored delta link back, exactly as Graph issued it.
    const incremental = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=delta-2` }),
    ]);
    const second = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: incremental.fetchImpl });
    expect(second).toMatchObject({ created: 0, updated: 1, fullSync: false, cursor: null });
    expect(second.books[1]).toMatchObject({ fullSync: false, cursor: `${DELTA_BASE}?$deltatoken=delta-2` });
    expect(incremental.urls[0]).toBe(`${DELTA_BASE}?$deltatoken=baseline`);
  });

  it.each(['Contacts', 'Kontakte', 'Arbitrary first folder'])('does not let a discovered %s folder suppress default contacts, even when that folder fails', async displayName => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({ error: { code: 'ErrorItemNotFound', message: 'folder unavailable' } }, 404),
    ], [{ id: FOLDER_ID, displayName, parentFolderId: null }]);
    const urls: string[] = [];
    const result = await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: async (url, init) => {
        const target = String(url);
        urls.push(target);
        if (target.includes('/me/contacts?')) return json({ value: [contact('default-only', 'Default Person', 'default@contoso.test')] });
        return provider.fetchImpl(url, init);
      },
    });
    expect(urls.filter(url => url.includes('/me/contacts?'))).toHaveLength(1);
    expect(result).toMatchObject({ created: 1, incomplete: true, errors: [{ folderId: FOLDER_ID, code: 'RESOURCE_NOT_FOUND' }] });
    expect(result.books).toHaveLength(1);
    expect((await storedContacts()).map(row => row.uid)).toEqual(['msgraph-default-only']);
    const states = await autocommit(client => client.query<{
      remote_id: string; local_address_book_id: string; last_success_at: Date | null; last_error_code: string | null; running_owner: string | null;
    }>(`SELECT c.remote_id, c.local_address_book_id, s.last_success_at, s.last_error_code, s.running_owner
         FROM integration_collections c JOIN sync_states s ON s.collection_id = c.id
         WHERE c.connection_id = $1 ORDER BY c.remote_id`, [connectionId]));
    expect(states.rows).toHaveLength(2);
    expect(states.rows.find(row => row.remote_id === DEFAULT_GRAPH_CONTACTS_TARGET)).toMatchObject({
      local_address_book_id: result.addressBookId, last_success_at: expect.any(Date), last_error_code: null, running_owner: null,
    });
    expect(states.rows.find(row => row.remote_id === FOLDER_ID)).toMatchObject({ last_success_at: null, last_error_code: 'RESOURCE_NOT_FOUND', running_owner: null });
  });

  it('keeps default contacts available when folder discovery fails', async () => {
    const connectionId = await seedConnection();
    const result = await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: async url => String(url).includes('/me/contacts?')
        ? json({ value: [contact('default-only', 'Default Person', 'default@contoso.test')] })
        : json({ error: { code: 'ErrorAccessDenied', message: 'discovery unavailable' } }, 403),
    });
    expect(result).toMatchObject({ created: 1, incomplete: true, errors: [{ folderId: 'discovery', stage: 'discovery', code: 'INSUFFICIENT_SCOPES' }] });
    expect(result.books).toHaveLength(1);
    expect((await storedContacts()).map(row => row.uid)).toEqual(['msgraph-default-only']);
  });

  it('keeps two Graph identities with the same e-mail in one folder', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({
        value: [
          contact('c-same-1', 'Ada Lovelace', 'shared@contoso.test'),
          contact('c-same-2', 'Grace Hopper', 'shared@contoso.test'),
        ],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=same-email-1`,
      }),
      () => json({
        value: [
          contact('c-same-1', 'Ada Lovelace', 'shared@contoso.test'),
          contact('c-same-2', 'Grace Hopper', 'shared@contoso.test'),
        ],
        '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=same-email-2`,
      }),
    ]);

    const first = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(first).toMatchObject({ created: 2, incomplete: false });
    const initial = await storedContacts();
    expect(initial.map(row => row.uid)).toEqual(['msgraph-c-same-1', 'msgraph-c-same-2']);
    expect(initial.map(row => row.primary_email)).toEqual(['shared@contoso.test', 'shared@contoso.test']);

    const second = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(second).toMatchObject({ created: 0, updated: 2, incomplete: false });
    const repeated = await storedContacts();
    expect(repeated.map(row => row.uid)).toEqual(['msgraph-c-same-1', 'msgraph-c-same-2']);
  });

  it('stores the birthday and IM addresses a Graph contact carries, and leaves the anniversary unmapped', async () => {
    // GRAPH-03: the v1.0 contact resource has no anniversary property (beta names a different one), so it is
    // neither requested nor mapped. The local column is left alone rather than filled from a field the API
    // does not return.
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
      anniversary: null,
      // A bare Graph IM address has no protocol, so it is typed `other`, and the empty entry is gone.
      instant_messages: [{ value: 'ada@jabber.example', type: 'other' }],
    });

    // A locally stored anniversary is not Graph's to clear: a re-sync must leave it alone.
    await autocommit(client => client.query(
      "UPDATE contacts SET anniversary = '1835-07-08' WHERE user_id = $1", [USER_ID],
    ));
    await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([
        () => json({
          value: [{ ...contact('c9', 'Ada Lovelace', 'ada@contoso.test'), birthday: '1815-12-10T00:00:00Z' }],
          '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=fields-2`,
        }),
      ]).fetchImpl,
    });
    const after = await autocommit(client => client.query<{ anniversary: string | null }>(
      'SELECT anniversary::text AS anniversary FROM contacts WHERE user_id = $1', [USER_ID],
    ));
    expect(after.rows[0]?.anniversary).toBe('1835-07-08');
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
    expect(result).toMatchObject({ deleted: 1, cursor: null });
    expect(result.books[1]).toMatchObject({ fullSync: true, cursor: `${DELTA_BASE}?$deltatoken=fresh` });
    // The folder cursor belongs to its own book, never the default collection.
    expect(provider.urls[1]).not.toContain('$deltatoken=stale');

    // A plain re-read would have left the deleted contact behind; reconciliation removes it.
    expect((await storedContacts()).map(row => row.uid)).toEqual(['msgraph-c1']);
    const link = await autocommit(client => client.query<{ status: string }>(
      `SELECT status FROM remote_object_links WHERE user_id = $1 AND object_remote_id = 'c2'`, [USER_ID],
    ));
    expect(link.rows[0]?.status).toBe('deleted');
  });

  it('records a real-folder failure without misreporting the independent default collection as upstream failure', async () => {
    const connectionId = await seedConnection();
    const provider = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.nextLink': `${DELTA_BASE}?$skiptoken=page-2` }),
      () => json({ error: { code: 'ErrorInternalServerError', message: 'server error' } }, 500),
    ]);

    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    expect(result).toMatchObject({ incomplete: true, errors: [{ folderId: FOLDER_ID, code: 'UPSTREAM_UNAVAILABLE' }] });

    const state = await autocommit(client => client.query<{ last_error_code: string | null; last_error_at: Date | null }>(
      'SELECT last_error_code, last_error_at FROM sync_states WHERE user_id = $1 AND feature = $2', [USER_ID, 'contacts'],
    ));
    expect(state.rows.some(row => row.last_error_code === 'UPSTREAM_UNAVAILABLE' && row.last_error_at !== null)).toBe(true);
  });

  it('pulls every contact folder into its own address book', async () => {
    // GRAPH-03: a mailbox has more than one contact folder, and a contact is invisible while only the default one
    // is pulled. Each discovered folder — including a nested one — becomes its own book, with its own delta.
    const connectionId = await seedConnection();
    const SECOND_ID = 'AAMkAD-contact-folder-2';
    const CHILD_ID = 'AAMkAD-contact-folder-1-child';
    const provider = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.deltaLink': `${delataBaseFor(FOLDER_ID)}?$deltatoken=default` }),
      () => json({ value: [contact('c2', 'Grace Hopper', 'grace@contoso.test')], '@odata.deltaLink': `${delataBaseFor(SECOND_ID)}?$deltatoken=work` }),
      () => json({ value: [contact('c3', 'Alan Turing', 'alan@contoso.test')], '@odata.deltaLink': `${delataBaseFor(CHILD_ID)}?$deltatoken=team` }),
    ], [
      { id: FOLDER_ID, displayName: 'Contacts', parentFolderId: null },
      { id: SECOND_ID, displayName: 'Work', parentFolderId: null },
      { id: CHILD_ID, displayName: 'Team', parentFolderId: FOLDER_ID },
    ]);

    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });

    expect(result).toMatchObject({ created: 3, updated: 0, deleted: 0, errors: [] });
    // No discovered name proves default identity: keep all three folder books
    // and the explicit default collection independently addressable.
    expect(result.books).toHaveLength(4);
    expect(new Set(result.books.map(book => book.addressBookId)).size).toBe(4);
    expect(provider.defaultUrls).toHaveLength(1);
    expect(provider.urls.map(url => decodeURIComponent(url))).toEqual([
      expect.stringContaining(`/me/contactFolders/${FOLDER_ID}/contacts/delta`),
      expect.stringContaining(`/me/contactFolders/${SECOND_ID}/contacts/delta`),
      expect.stringContaining(`/me/contactFolders/${CHILD_ID}/contacts/delta`),
    ]);

    const books = await autocommit(client => client.query<{ name: string }>(
      'SELECT name FROM address_books WHERE user_id = $1 ORDER BY name', [USER_ID],
    ));
    expect(books.rows.map(row => row.name)).toEqual(['Contacts', 'Microsoft Contacts', 'Team', 'Work']);
  });

  it('records an additional folder’s failure and still synchronises the rest', async () => {
    // One extra folder must not stop the others (the isolation GRAPH-06 established for mail folders), while the
    // default folder's own failure is thrown — a mailbox that pulled nothing must not look healthy.
    const connectionId = await seedConnection();
    const SECOND_ID = 'AAMkAD-contact-folder-2';
    const provider = fakeProvider([
      () => json({ value: [contact('c1', 'Ada Lovelace', 'ada@contoso.test')], '@odata.deltaLink': `${delataBaseFor(FOLDER_ID)}?$deltatoken=default` }),
      () => json({ error: { code: 'ErrorInternalServerError', message: 'server error' } }, 500),
    ], [
      { id: FOLDER_ID, displayName: 'Contacts', parentFolderId: null },
      { id: SECOND_ID, displayName: 'Work', parentFolderId: null },
    ]);

    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });

    // The default folder's contact arrived, the failing folder is named, and the run is not claimed as complete.
    expect(result).toMatchObject({ created: 1, incomplete: true, errors: [{ folderId: SECOND_ID, code: 'UPSTREAM_UNAVAILABLE' }] });
    expect(result.books).toHaveLength(2);
  });

  it('refuses a second concurrent sync for the same connection', async () => {
    const connectionId = await seedConnection();
    await syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ value: [], '@odata.deltaLink': `${DELTA_BASE}?$deltatoken=empty` })]).fetchImpl,
    });

    const collection = await autocommit(client => client.query<{ id: string }>(
      `SELECT id FROM integration_collections WHERE user_id = $1 AND kind = 'address_book' AND remote_id = $2`, [USER_ID, DEFAULT_GRAPH_CONTACTS_TARGET],
    ));
    const syncStateId = await inTransaction(client => ensureSyncState(client, {
      userId: USER_ID, connectionId, feature: 'contacts', collectionId: collection.rows[0]?.id ?? null, coverage: 'personal',
    }));
    expect(await inTransaction(client => acquireSyncLease(client, { syncStateId, owner: 'other-worker' }))).not.toBeNull();

    await expect(syncGraphContacts({
      userId: USER_ID, connectionId, config: CONFIG,
      fetchImpl: fakeProvider([() => json({ value: [] })]).fetchImpl,
    })).rejects.toMatchObject({ name: 'GraphApiError', code: 'SYNC_ALREADY_RUNNING' });
  });
});
