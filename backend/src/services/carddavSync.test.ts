import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryResult = { rows: Record<string, unknown>[] };
type QueryParameter = string | null;
type Query = (sql: string, params: QueryParameter[]) => Promise<QueryResult>;
type AddressBook = { url: string; displayName: string };
type AddressBookCard = { href: string; vcard: string; etag?: string | null };
type ConnectionPolicy = { allowPrivateHosts: boolean };

const { query, transactionQuery, discoverAddressBooks, fetchAddressBookCards, getConnectionPolicy } = vi.hoisted(() => ({
  query: vi.fn<Query>(),
  transactionQuery: vi.fn<Query>(),
  discoverAddressBooks: vi.fn<() => Promise<AddressBook[]>>(),
  fetchAddressBookCards: vi.fn<() => Promise<AddressBookCard[]>>(),
  getConnectionPolicy: vi.fn<() => Promise<ConnectionPolicy>>(),
}));
vi.mock('./db.js', () => ({
  query,
  // DAV-04: the pull's delete/upsert/merge/token phase runs in one transaction. The transaction client is a
  // separate mock, so a case can prove those statements went through it rather than through the pool.
  withTransaction: async (fn: (client: { query: Query }) => unknown) => fn({ query: transactionQuery }),
}));
vi.mock('./carddavClient.js', () => ({ discoverAddressBooks, fetchAddressBookCards }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('./encryption.js', () => ({ decrypt: (value: string) => value, encrypt: (value: string) => `enc:v1:${value}` }));

import { syncUser } from './carddavSync.js';

const appleCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:apple-1\r\nFN:Apple Contact\r\nPHOTO;TYPE=JPEG:YWJj\r\nX-ABDATE;TYPE=Wedding:2020-09-14\r\nX-ABDATE;TYPE=Wedding:20200914\r\nEND:VCARD\r\n';
const androidCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:android-1\r\nFN:Android Contact\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2019-10-19;0;Rencontre;\r\nEND:VCARD\r\n';
const appleMergeCard = appleCard.replace('FN:Apple Contact\r\n', 'FN:Apple Contact\r\nEMAIL:duplicate@example.com\r\nBDAY:1990-01-02\r\nANNIVERSARY:2020-09-14\r\n');
const androidMergeCard = androidCard.replace('FN:Android Contact\r\n', 'FN:Android Contact\r\nEMAIL:duplicate@example.com\r\nBDAY:1991-02-03\r\nANNIVERSARY:2021-10-19\r\n');
const invalidBirthdayCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:invalid-birthday\r\nFN:Invalid Birthday\r\nBDAY:2020-02-30\r\nEND:VCARD\r\n';
const invalidAndroidDateCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:invalid-android-date\r\nFN:Invalid Android Date\r\nX-ANDROID-CUSTOM:vnd.android.cursor.item/contact_event;2024-04-31;0;Meeting;\r\nEND:VCARD\r\n';

function parseJsonParameter(value: QueryParameter): unknown {
  if (typeof value !== 'string') throw new Error('Expected a JSON query parameter');
  return JSON.parse(value);
}

function configureSync() {
  const handler = async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT config FROM user_integrations')) return { rows: [{ config: { serverUrl: 'https://dav.example', username: 'user', password: 'password' } }] };
    if (sql.includes('SELECT id FROM address_books')) return { rows: [{ id: 'book-1' }] };
    // The external-collection link (P02/P10): the helper asks for the source connection and then for the
    // collection, and a real database returns the new ids.
    if (sql.includes('INSERT INTO source_connections')) return { rows: [{ id: 'source-conn-1' }] };
    if (sql.includes('INSERT INTO integration_collections')) return { rows: [{ id: 'collection-1' }] };
    // The contact upsert returns the row it wrote — the local id a link is anchored to (DAV-04). The uid is the
    // third parameter, so the id is stable per card and an assertion can name it.
    if (sql.includes('INSERT INTO contacts')) return { rows: [{ id: `contact-${String(params?.[2] ?? 'unknown')}` }] };
    return { rows: [] };
  };
  query.mockImplementation(handler);
  // The transaction client sees the same database (DAV-04).
  transactionQuery.mockImplementation(handler);
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
  discoverAddressBooks.mockResolvedValue([{ url: 'https://dav.example/contacts', displayName: 'Contacts' }]);
  fetchAddressBookCards.mockResolvedValue([
    { href: '/apple.vcf', vcard: appleCard, etag: '"etag-apple"' },
    { href: '/android.vcf', vcard: androidCard, etag: '"etag-android"' },
  ]);
}

describe('remote CardDAV contact-date persistence', () => {
  beforeEach(() => {
    query.mockReset(); transactionQuery.mockReset();
    discoverAddressBooks.mockReset(); fetchAddressBookCards.mockReset(); getConnectionPolicy.mockReset();
    configureSync();
  });

  it('applies the whole pull through one transaction', async () => {
    // DAV-04: the delete of rows the snapshot no longer lists, the upserts, the merges and the new sync token
    // used to run as separate statements, so a failure halfway left the book missing rows until the next
    // successful pass. They are now issued through one transaction client.
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true });

    const inTransaction = transactionQuery.mock.calls.map(([sql]) => String(sql));
    expect(inTransaction.some(sql => sql.includes('DELETE FROM contacts'))).toBe(true);
    expect(inTransaction.some(sql => sql.includes('INSERT INTO contacts'))).toBe(true);
    expect(inTransaction.some(sql => sql.includes('UPDATE address_books SET sync_token'))).toBe(true);

    // None of the apply statements ran outside it.
    const outside = query.mock.calls.map(([sql]) => String(sql));
    expect(outside.some(sql => sql.includes('DELETE FROM contacts'))).toBe(false);
    expect(outside.some(sql => sql.includes('INSERT INTO contacts'))).toBe(false);
    expect(outside.some(sql => sql.includes('UPDATE address_books SET sync_token'))).toBe(false);
  });

  it('links the external address book to its source connection so write-back has something to enable', async () => {
    // P02/P10: a CardDAV book belongs to the user and is addressed with the user's own credentials, so the
    // link records the source's permission as writable while the user's choice stays read-only until they
    // opt in. Without the link the write-back switch has no collection id and is never offered.
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true });

    const link = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO integration_collections'));
    expect(link).toBeDefined();
    const sql = String(link?.[0]);
    expect(sql).toContain('INSERT INTO integration_collections');
    expect(sql).toContain("'source', 'off'");
    expect(link?.[1]).toEqual([
      'user-1', expect.any(String), 'address_book', 'https://dav.example/contacts', null, 'book-1', 'read_write',
    ]);

    // Idempotency is a database property (the helper's SELECT finds the row a previous pass wrote), so it is
    // proven against a real PostgreSQL by `providers/externalCollectionLinks.integration.test.ts` rather than
    // by a mock that would have to remember its own inserts.
  });

  it('binds Apple and Android labelled dates to contact_dates and updates them idempotently', async () => {
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 2 });

    const upserts = transactionQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(upserts).toHaveLength(2);
    for (const [sql, params] of upserts) {
      expect(sql).toContain('anniversary, contact_dates, photo_data');
      expect(sql).toContain('$16::jsonb,$17,$18,$19,$20,$21::jsonb');
      expect(sql).toContain('contact_dates = EXCLUDED.contact_dates');
      expect(parseJsonParameter(params[15])).toEqual([
        params[2] === 'apple-1' ? { label: 'Wedding', value: '2020-09-14' } : { label: 'Rencontre', value: '2019-10-19' },
      ]);
      expect(params[2]).toMatch(/^(apple|android)-1$/);
      expect(params[3]).toMatch(/^BEGIN:VCARD/);
      expect(params[4]).toMatch(/^[a-f0-9]{32}$/);
      expect(params[16]).toBe(params[2] === 'apple-1' ? 'data:image/jpeg;base64,YWJj' : null);
    }

    query.mockClear();
    transactionQuery.mockClear();
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 2 });
    const secondUpserts = transactionQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(secondUpserts.map(([, params]) => params[15])).toEqual(upserts.map(([, params]) => params[15]));
  });

  it.each([
    ['Apple', '/apple.vcf', appleMergeCard, [
      { label: 'Birthday', value: '1990-01-02' }, { label: 'Anniversary', value: '2020-09-14' }, { label: 'Wedding', value: '2020-09-14' },
    ]],
    ['Android', '/android.vcf', androidMergeCard, [
      { label: 'Birthday', value: '1991-02-03' }, { label: 'Anniversary', value: '2021-10-19' }, { label: 'Rencontre', value: '2019-10-19' },
    ]],
  ])('merges %s labelled dates into an existing matching-email contact idempotently', async (_source, href, vcard, contactDates) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT config FROM user_integrations')) return { rows: [{ config: { serverUrl: 'https://dav.example', username: 'user', password: 'password', dupMode: 'merge' } }] };
      if (sql.includes('SELECT id FROM address_books')) return { rows: [{ id: 'book-1' }] };
      // The owner's book source travels with the match, because a provider-owned contact may not be merged
      // into (DAV-03). A local book is the user's own, so the merge applies.
      if (sql.includes('JOIN address_books')) return { rows: [{ id: 'existing-contact-1', primary_email: 'duplicate@example.com', source: 'local' }] };
      return { rows: [] };
    });
    fetchAddressBookCards.mockResolvedValue([{ href, vcard }]);

    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 0 });
    const mergeCall = transactionQuery.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    expect(mergeCall).toBeDefined();
    if (!mergeCall) throw new Error('Expected an existing-contact merge query');
    const [mergeSql, mergeParams] = mergeCall;

    expect(mergeSql).toContain('contact_dates = $10::jsonb');
    expect(mergeSql).toContain('photo_data = COALESCE($11, photo_data)');
    expect(mergeSql).toContain('urls = $15::jsonb, instant_messages = $16::jsonb, categories = $17::jsonb, addresses = $18::jsonb');
    expect(mergeSql).not.toContain('primary_email =');
    expect(mergeParams[0]).toBe('existing-contact-1');
    expect(mergeParams[1]).toBe('Apple Contact'.replace('Apple', _source));
    expect(mergeParams[2]).toBeNull();
    expect(mergeParams[3]).toBeNull();
    expect(mergeParams[7]).toBe(_source === 'Apple' ? '1990-01-02' : '1991-02-03');
    expect(mergeParams[8]).toBe(_source === 'Apple' ? '2020-09-14' : '2021-10-19');
    expect(parseJsonParameter(mergeParams[9])).toEqual(contactDates);
    expect(mergeParams[10]).toBe(_source === 'Apple' ? 'data:image/jpeg;base64,YWJj' : null);
    expect(mergeParams.slice(14, 18)).toEqual(['[]', '[]', '[]', '[]']);
    expect(mergeParams[18]).toBe(vcard);
    expect(mergeParams[19]).toBe(crypto.createHash('md5').update(vcard).digest('hex'));

    query.mockClear();
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 0 });
    const secondMergeCall = transactionQuery.mock.calls.find(([sql]) => sql.includes('UPDATE contacts SET'));
    expect(secondMergeCall).toBeDefined();
    if (!secondMergeCall) throw new Error('Expected a repeated existing-contact merge query');
    const [, secondMergeParams] = secondMergeCall;
    expect(secondMergeParams[9]).toBe(mergeParams[9]);
  });

  it('records each card’s href and ETag, and retires the links the snapshot no longer lists', async () => {
    // DAV-04: the write-back resolves a contact through `remote_object_links`. Without a row it had to scan the
    // whole book for the UID and had no ETag to present, so the pull now records where each card lives and the
    // version it was read at, and retires the links of cards that left the snapshot.
    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 2 });

    const links = transactionQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO remote_object_links'));
    expect(links).toHaveLength(2);
    // The INSERT's parameters are user, collection, local id, collection remote id, uid, href, etag.
    const params = links.map(([, values]) => values as unknown[]);
    expect(params.map(row => row[4])).toEqual(['apple-1', 'android-1']);
    for (const row of params) {
      expect(row[0]).toBe('user-1');
      expect(row[1]).toBe('collection-1');
      expect(row[2]).toMatch(/^contact-/);
      expect(row[3]).toBe('https://dav.example/contacts');
      expect(row[5]).toMatch(/\.vcf$/);
      // The ETag the source issued travels with the card, so a write-back can present it as a precondition.
      expect(row[6]).toBe(row[5] === '/apple.vcf' ? '"etag-apple"' : '"etag-android"');
    }

    const retire = transactionQuery.mock.calls.find(([sql]) => sql.includes("status = 'deleted', local_id = NULL"));
    expect(retire, 'links of cards that left the snapshot are not retired').toBeDefined();
    expect(String(retire?.[0])).toContain('object_type = \'contact\'');
  });

  it('never merges into a contact that another provider owns', async () => {
    // DAV-03: `dupMode=merge` wrote the DAV card's fields onto a matching contact in a Google or Microsoft book.
    // This pull has no write-through to that provider, so the overwrite existed only locally and the provider's
    // next sync reverted it — whichever change came second was lost. The card is created in its own book instead.
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT config FROM user_integrations')) return { rows: [{ config: { serverUrl: 'https://dav.example', username: 'user', password: 'password', dupMode: 'merge' } }] };
      if (sql.includes('SELECT id FROM address_books')) return { rows: [{ id: 'book-1' }] };
      if (sql.includes('JOIN address_books')) return { rows: [{ id: 'google-contact-1', primary_email: 'duplicate@example.com', source: 'google' }] };
      return { rows: [] };
    });
    fetchAddressBookCards.mockResolvedValue([{ href: '/apple.vcf', vcard: appleMergeCard }]);

    await expect(syncUser('user-1')).resolves.toMatchObject({ ok: true, contactCount: 1 });

    // The other source's row is not touched, and the card lands as its own contact in this book.
    expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('UPDATE contacts SET'))).toBe(false);
    const upserts = transactionQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[1][2]).toBe('apple-1');
  });

  it.each([
    ['birthday', invalidBirthdayCard],
    ['Android labelled date', invalidAndroidDateCard],
  ])('rejects a remote vCard with an invalid %s before address-book or contact writes', async (_source, vcard) => {
    fetchAddressBookCards.mockResolvedValue([{ href: '/invalid.vcf', vcard }]);

    await expect(syncUser('user-1')).resolves.toMatchObject({
      ok: false,
      error: 'Remote CardDAV vCard contains an invalid contact date',
    });

    const postConfigQueries = query.mock.calls.slice(1);
    expect(postConfigQueries).toHaveLength(1);
    expect(postConfigQueries[0][0]).toContain('UPDATE user_integrations SET config');
  });
});

it('releases the sync lock when loading connection policy fails', async () => {
  query.mockReset(); configureSync();
  getConnectionPolicy.mockRejectedValueOnce(new Error('Temporary policy failure'));
  expect(await syncUser('policy-retry-user')).toMatchObject({ ok: false, error: 'Temporary policy failure' });
  expect(await syncUser('policy-retry-user')).toMatchObject({ ok: true, contactCount: 2 });
});
