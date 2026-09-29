// Real PostgreSQL tests for the Microsoft Graph contacts sync (P07/P09). The
// provider is faked at the HTTP boundary; discovery, the remote link, the vCard
// projection, the lease, the delta cursor and the baseline reconciliation are real.
//
// Run with:
//   DB_HOST=localhost DB_PORT=5432 DB_NAME=mailflow_test DB_USER=… DB_PASSWORD=… \
//     npx vitest run src/services/providers/microsoft/graphContactsSync.integration.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import * as collectionFence from '../../addressBookCollectionFence.js';
import { deleteProviderAddressBook, describeAddressBookDeletion } from '../../addressBookCollectionManagement.js';
import { ensureGraphAddressBook, syncGraphContacts } from './graphContactsSync.js';
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

async function seedConnection(subject = 'ms-sub-contacts'): Promise<string> {
  return inTransaction(async client => {
    const connectionId = await upsertProviderConnection(client, {
      userId: USER_ID, provider: 'microsoft', issuer: MICROSOFT_ISSUER, subject,
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
      await client.query('DELETE FROM email_accounts WHERE user_id = $1', [USER_ID]);
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
  it('does not rewrite unchanged contact tuples or churn CardDAV versions on replay', async () => {
    const connectionId = await seedConnection();
    const record = contact('stable', 'Stable Person', 'stable@example.test');
    const provider = fakeProvider([() => json({ value: [record], '@odata.deltaLink': DELTA_BASE + '?$deltatoken=stable' })]);
    const run = () => syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: provider.fetchImpl });
    await run();
    const snapshot = async () => (await autocommit(client => client.query(
      `SELECT c.id, c.ctid::text AS tuple, c.vcard, c.etag, b.sync_version::text AS version
       FROM contacts c JOIN address_books b ON b.id=c.address_book_id WHERE c.user_id=$1 ORDER BY c.id`, [USER_ID]))).rows;
    const before = await snapshot();
    expect(before).toHaveLength(1);
    await expect(run()).resolves.toMatchObject({ incomplete: false, errors: [] });
    await expect(run()).resolves.toMatchObject({ incomplete: false, errors: [] });
    expect(await snapshot()).toEqual(before);
  });

  it('retires a missing folder and its contacts, fences a late ensure, and permits a new provider identity', async () => {
    const connectionId = await seedConnection();
    const first = fakeProvider([() => json({ value: [contact('gone', 'Gone', 'gone@test.invalid')] })]);
    const before = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: first.fetchImpl });
    const missing = fakeProvider([], []);
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: missing.fetchImpl });
    expect((await pool.query('SELECT 1 FROM address_books WHERE id=$1', [before.books[1].addressBookId])).rows).toHaveLength(0);
    expect(await storedContacts()).toHaveLength(0);
    await expect(inTransaction(client => ensureGraphAddressBook(client, { userId: USER_ID, connectionId, folderId: FOLDER_ID }))).rejects.toThrow('confirmed deletion fence');
    const replacement = fakeProvider([() => json({ value: [contact('new', 'New', 'new@test.invalid')] })], [{ id: 'replacement-id', displayName: 'Contacts', parentFolderId: null }]);
    expect((await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: replacement.fetchImpl })).created).toBe(1);
  });

  it.each(['malformed', 'page-cap', 'forbidden', 'timeout'])('does not retire folders after %s discovery', async failure => {
    const connectionId = await seedConnection();
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([() => json({ value: [contact('safe', 'Safe', 'safe@test.invalid')] })]).fetchImpl });
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes('/me/contacts?')) return json({ value: [] });
      if (failure === 'malformed') return json({ value: [{ displayName: 'No identity' }] });
      if (failure === 'forbidden') return json({ error: { code: 'ErrorAccessDenied' } }, 403);
      if (failure === 'timeout') throw new Error('synthetic timeout');
      return json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contactFolders?$skiptoken=loop' });
    };
    const result = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl });
    expect(result.incomplete).toBe(true);
    expect((await storedContacts()).map(row => row.display_name)).toEqual(['Safe']);
    expect((await pool.query('SELECT 1 FROM address_book_collection_tombstones WHERE user_id=$1 AND connection_id=$2', [USER_ID, connectionId])).rows).toHaveLength(0);
  });

  async function managedFixture(deleteStatus = 204, timeout = false) {
    const connectionId = await seedConnection();
    const account = (await pool.query<{ id: string }>(`INSERT INTO email_accounts(user_id,name,email_address,imap_host,imap_port,smtp_host,smtp_port,auth_user,auth_pass,provider_connection_id)
      VALUES($1,'Synthetic Contacts','contacts@example.test','example.test',993,'example.test',587,'user','unused',$2) RETURNING id`, [USER_ID, connectionId])).rows[0];
    await pool.query("INSERT INTO account_provider_feature_settings(account_id,feature,enabled) VALUES($1,'contacts',true)", [account.id]);
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([() => json({ value: [contact('managed', 'Managed', 'managed@test.invalid')] })]).fetchImpl });
    const book = (await pool.query<{ id: string; name: string }>(`SELECT ab.id,ab.name FROM address_books ab JOIN integration_collections ic ON ic.local_address_book_id=ab.id WHERE ic.connection_id=$1 AND ic.remote_id=$2`, [connectionId, FOLDER_ID])).rows[0];
    await pool.query("UPDATE integration_collections SET user_access='read_write' WHERE connection_id=$1", [connectionId]);
    let deletes = 0;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'DELETE') {
        deletes++;
        if (timeout) throw new Error('lost provider response');
        return json(deleteStatus === 204 ? null : { error: { code: 'ErrorAccessDenied' } }, deleteStatus);
      }
      if (url.includes('/me/contacts?')) return json({ value: [{ parentFolderId: 'stable-default-folder' }] });
      return json({ id: FOLDER_ID });
    };
    return { book, connectionId, options: { graphApi: { config: CONFIG, fetchImpl } }, deleteCount: () => deletes };
  }

  it('deletes the provider folder, projects only a confirmed 204, and replays after local cleanup', async () => {
    const fixture = await managedFixture();
    expect(await describeAddressBookDeletion(USER_ID, fixture.book.id, fixture.options)).toEqual({ supported: true });
    const input = { userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() };
    const result = await deleteProviderAddressBook(input, fixture.options);
    expect(result.status).toBe('confirmed');
    expect(await storedContacts()).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM address_books WHERE id=$1', [fixture.book.id])).rows).toHaveLength(0);
    expect(await deleteProviderAddressBook(input, fixture.options)).toMatchObject({ status: 'confirmed', replayed: true, operationId: result.operationId });
    expect(fixture.deleteCount()).toBe(1);
  });

  it.each([{ status: 403, timeout: false, outcome: 'permanent' }, { status: 202, timeout: false, outcome: 'outcome_unknown' }, { status: 204, timeout: true, outcome: 'outcome_unknown' }])('retains projection for unconfirmed provider result $outcome ($status)', async failure => {
    const fixture = await managedFixture(failure.status, failure.timeout);
    const input = { userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() };
    expect((await deleteProviderAddressBook(input, fixture.options)).status).toBe(failure.outcome);
    expect((await deleteProviderAddressBook(input, fixture.options)).status).toBe(failure.outcome);
    expect(fixture.deleteCount()).toBe(1);
    expect(await storedContacts()).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM address_books WHERE id=$1', [fixture.book.id])).rows).toHaveLength(1);
  });

  it('protects the stable default folder despite its localized display name and refuses foreign ownership', async () => {
    const fixture = await managedFixture();
    const options = { graphApi: { config: CONFIG, fetchImpl: async (): Promise<Response> => json({ value: [{ parentFolderId: FOLDER_ID }] }) } };
    expect(await describeAddressBookDeletion(USER_ID, fixture.book.id, options)).toMatchObject({ supported: false, reason: expect.stringContaining('default') });
    await expect(deleteProviderAddressBook({ userId: crypto.randomUUID(), addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() }, fixture.options)).rejects.toMatchObject({ status: 404 });
    expect(fixture.deleteCount()).toBe(0);
  });

  it('restores a re-observed contact folder but preserves confirmed deletion fences', async () => {
    const connectionId = await seedConnection();
    const present = () => fakeProvider([() => json({ value: [contact('returning', 'Returned', 'returned@test.invalid')] })]).fetchImpl;
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: present() });
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([], []).fetchImpl });
    expect(await storedContacts()).toHaveLength(0);
    expect((await pool.query('SELECT retirement_reason FROM address_book_collection_tombstones WHERE connection_id=$1', [connectionId])).rows)
      .toEqual([{ retirement_reason: 'complete_discovery' }]);
    const restored = await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: present() });
    expect(restored.errors).toEqual([]); expect(await storedContacts()).toHaveLength(1);
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([], []).fetchImpl });
    await pool.query("UPDATE address_book_collection_tombstones SET retirement_reason='confirmed_delete' WHERE connection_id=$1", [connectionId]);
    expect((await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: present() })).incomplete).toBe(true);
    expect(await storedContacts()).toHaveLength(0);
  });

  it('limits discovery retirement to the exact connection and preserves user-local books', async () => {
    const one = await seedConnection('first');
    const two = await seedConnection('second');
    for (const connectionId of [one, two]) await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl: fakeProvider([() => json({ value: [contact('shared-remote-id', 'Kept', 'kept@test.invalid')] })]).fetchImpl });
    const local = await pool.query<{ id: string }>("INSERT INTO address_books(user_id,name,source) VALUES($1,'User Local','local') RETURNING id", [USER_ID]);
    await syncGraphContacts({ userId: USER_ID, connectionId: one, config: CONFIG, fetchImpl: fakeProvider([], []).fetchImpl });
    expect((await pool.query('SELECT 1 FROM integration_collections WHERE connection_id=$1 AND remote_id=$2', [two, FOLDER_ID])).rows).toHaveLength(1);
    expect(await storedContacts()).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM address_books WHERE id=$1', [local.rows[0].id])).rows).toHaveLength(1);
  });

  it('checks complete discovery after an unknown delete without sending another DELETE', async () => {
    const fixture = await managedFixture(204, true);
    const input = { userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() };
    expect((await deleteProviderAddressBook(input, fixture.options)).status).toBe('outcome_unknown');
    const options = { graphApi: { config: CONFIG, fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url).toContain('/me/contactFolders');
      return json({ value: [] });
    } } };
    expect((await deleteProviderAddressBook(input, options)).status).toBe('confirmed');
    expect(fixture.deleteCount()).toBe(1);
    expect(await storedContacts()).toHaveLength(0);
  });

  it('does not offer Google primary deletion or guess the default Microsoft identity from an empty folder', async () => {
    const fixture = await managedFixture();
    const options = { graphApi: { config: CONFIG, fetchImpl: async (): Promise<Response> => json({ value: [] }) } };
    expect(await describeAddressBookDeletion(USER_ID, fixture.book.id, options)).toMatchObject({ supported: false, reason: expect.stringContaining('empty') });
    const google = (await pool.query<{ id: string }>("INSERT INTO address_books(user_id,name,source) VALUES($1,'Primary Google','google') RETURNING id", [USER_ID])).rows[0];
    expect(await describeAddressBookDeletion(USER_ID, google.id, fixture.options)).toMatchObject({ supported: false, reason: expect.stringContaining('primary') });
    expect(fixture.deleteCount()).toBe(0);
  });

  it('preserves a contact that has an active membership in another owned collection', async () => {
    const fixture = await managedFixture();
    const other = await inTransaction(client => ensureGraphAddressBook(client, { userId: USER_ID, connectionId: fixture.connectionId, folderId: 'surviving-folder', label: 'Surviving' }));
    const person = (await pool.query<{ id: string }>('SELECT id FROM contacts WHERE address_book_id=$1', [fixture.book.id])).rows[0];
    await pool.query(`INSERT INTO remote_object_links(user_id,connection_id,collection_id,object_type,local_id,collection_remote_id,object_remote_id,status)
      VALUES($1,$2,$3,'contact',$4,'surviving-folder','shared','active')`, [USER_ID, fixture.connectionId, other.collectionId, person.id]);
    expect((await deleteProviderAddressBook({ userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() }, fixture.options)).status).toBe('confirmed');
    expect((await pool.query('SELECT address_book_id FROM contacts WHERE id=$1', [person.id])).rows).toEqual([{ address_book_id: other.addressBookId }]);
    expect((await pool.query('SELECT 1 FROM remote_object_links WHERE collection_id=$1 AND local_id=$2', [other.collectionId, person.id])).rows).toHaveLength(1);
  });

  it('replays a confirmed provider deletion after local cleanup fails without another DELETE', async () => {
    const fixture = await managedFixture();
    const input = { userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() };
    const failure = vi.spyOn(collectionFence, 'retireAddressBookCollection').mockRejectedValueOnce(new Error('synthetic transaction failure'));
    try {
      expect(await deleteProviderAddressBook(input, fixture.options)).toMatchObject({ status: 'pending', code: 'PROJECTION_PENDING' });
      expect(await storedContacts()).toHaveLength(1);
      await expect(inTransaction(client => ensureGraphAddressBook(client, { userId: USER_ID, connectionId: fixture.connectionId, folderId: FOLDER_ID }))).rejects.toThrow('confirmed deletion fence');
      expect((await deleteProviderAddressBook(input, fixture.options)).status).toBe('confirmed');
      expect(await storedContacts()).toHaveLength(0);
      expect(fixture.deleteCount()).toBe(1);
    } finally { failure.mockRestore(); }
  });

  it('rejects a page started before confirmed deletion so it cannot recreate contacts', async () => {
    const fixture = await managedFixture();
    let releasePage: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const suspended = new Promise<void>(resolve => { releasePage = resolve; });
    const slow = fakeProvider([async () => {
      markStarted!();
      await suspended;
      return json({ value: [contact('stale', 'Stale', 'stale@test.invalid')] });
    }]);
    const pendingSync = syncGraphContacts({ userId: USER_ID, connectionId: fixture.connectionId, config: CONFIG, fetchImpl: slow.fetchImpl });
    await started;
    try {
      expect((await deleteProviderAddressBook({ userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() }, fixture.options)).status).toBe('confirmed');
    } finally { releasePage!(); }
    expect((await pendingSync).incomplete).toBe(true);
    expect(await storedContacts()).toHaveLength(0);
  });

  it('retains projection if consent is revoked while discovery is in flight', async () => {
    const fixture = await managedFixture();
    const fetchImpl = async (): Promise<Response> => {
      await pool.query("UPDATE oauth_grants SET status='revoked' WHERE connection_id=$1", [fixture.connectionId]);
      return json({ value: [] });
    };
    await expect(syncGraphContacts({ userId: USER_ID, connectionId: fixture.connectionId, config: CONFIG, fetchImpl })).rejects.toThrow();
    expect(await storedContacts()).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM address_book_collection_tombstones WHERE connection_id=$1', [fixture.connectionId])).rows).toHaveLength(0);
  });

  it('does not retire books when contacts are disabled during discovery', async () => {
    const fixture = await managedFixture();
    const fetchImpl = async (): Promise<Response> => {
      await pool.query(`UPDATE account_provider_feature_settings SET enabled=false
        WHERE feature='contacts' AND account_id IN (SELECT id FROM email_accounts WHERE user_id=$1)`, [USER_ID]);
      return json({ value: [] });
    };
    const outcome = await syncGraphContacts({ userId: USER_ID, connectionId: fixture.connectionId, config: CONFIG, fetchImpl });
    expect(outcome.incomplete).toBe(true);
    expect(await storedContacts()).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM address_book_collection_tombstones WHERE connection_id=$1', [fixture.connectionId])).rowCount).toBe(0);
  });

  it('retains a local projection created after the discovery snapshot started', async () => {
    const connectionId = await seedConnection();
    let created: { addressBookId: string; collectionId: string } | undefined;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes('/me/contactFolders?')) {
        created = await inTransaction(client => ensureGraphAddressBook(client, { userId: USER_ID, connectionId, folderId: 'new-during-discovery', label: 'Created During Discovery' }));
      }
      return json({ value: [] });
    };
    await syncGraphContacts({ userId: USER_ID, connectionId, config: CONFIG, fetchImpl });
    expect(created).toBeDefined();
    expect((await pool.query('SELECT 1 FROM address_books WHERE id=$1', [created!.addressBookId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM address_book_collection_tombstones WHERE connection_id=$1', [connectionId])).rows).toHaveLength(0);
  });

  it.each(['feature-disabled', 'scope-reduced', 'grant-revoked'])('refuses collection deletion after current authorization changes: %s', async changed => {
    const fixture = await managedFixture();
    if (changed === 'feature-disabled') await pool.query(`UPDATE account_provider_feature_settings SET enabled=false WHERE account_id IN (SELECT id FROM email_accounts WHERE user_id=$1)`, [USER_ID]);
    if (changed === 'scope-reduced') await pool.query("UPDATE oauth_grants SET current_scopes=ARRAY['Contacts.Read'] WHERE connection_id=$1", [fixture.connectionId]);
    if (changed === 'grant-revoked') await pool.query("UPDATE oauth_grants SET status='revoked' WHERE connection_id=$1", [fixture.connectionId]);
    expect(await describeAddressBookDeletion(USER_ID, fixture.book.id, fixture.options)).toMatchObject({ supported: false });
    await expect(deleteProviderAddressBook({ userId: USER_ID, addressBookId: fixture.book.id, confirmName: fixture.book.name, idempotencyKey: crypto.randomUUID() }, fixture.options)).rejects.toMatchObject({ status: 403 });
    expect(fixture.deleteCount()).toBe(0);
    expect(await storedContacts()).toHaveLength(1);
  });

});
