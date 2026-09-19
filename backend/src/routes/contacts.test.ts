import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient, DbQueryResult, DbRow } from '../services/db.js';
import type { ParsedVCard } from '../utils/vcard.js';

type WithTransaction = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;
type MockQuery = (text: string, params?: unknown[]) => Promise<DbQueryResult<DbRow>>;

const { query, withTransaction } = vi.hoisted(() => {
  const query = vi.fn<MockQuery>();
  const transactionQuery: DbClient['query'] = async (text, params) => {
    await query(text, params);
    return { rows: [] };
  };
  const withTransaction = vi.fn<WithTransaction>(async callback => callback({ query: transactionQuery }));
  return { query, withTransaction };
});
vi.mock('../services/db.js', () => ({ query, withTransaction }));

import express from 'express';
import session from 'express-session';
import contactsRouter from './contacts.js';
import { listeningPort } from '../test/net.js';

const existingVCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:contact-1',
  'FN:Ada',
  'BDAY;TYPE=Birthday:1990-01-02',
  'X-ABDATE;TYPE=Wedding:2020-09-14',
  'ANNIVERSARY;TYPE=Anniversary:2021-05-06',
  'END:VCARD',
].join('\r\n') + '\r\n';

type ContactDateEntry = ParsedVCard['contactDates'][number];

const updatedContact: {
  id: string; uid: string; display_name: string;
  emails: unknown[]; phones: unknown[]; contactDates: ContactDateEntry[];
  birthday: string | null; anniversary: string | null;
} = {
  id: 'contact-1', uid: 'contact-1', display_name: 'Ada',
  emails: [], phones: [], contactDates: [], birthday: null, anniversary: null,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = 'user-1'; next(); });
  app.use('/api/contacts', contactsRouter);
  return app;
}

function findQuery(sqlFragment: string): [string, unknown[]] {
  const call = query.mock.calls.find(([sql]) => sql.includes(sqlFragment));
  if (call === undefined || call[1] === undefined) {
    throw new Error(`Expected query containing "${sqlFragment}" with parameters`);
  }
  return [call[0], call[1]];
}

function stringParameter(params: unknown[], index: number): string {
  const value = params[index];
  if (typeof value !== 'string') throw new Error(`Expected string query parameter at index ${index}`);
  return value;
}

function arrangeQuery(contact: ContactDateEntry[], result: typeof updatedContact) {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    .mockResolvedValueOnce({ rows: [{
      id: 'contact-1', uid: 'contact-1', display_name: 'Ada', first_name: null, last_name: null,
      primary_email: null, emails: [], phones: [], organization: null, notes: null,
      birthday: '1990-01-02', anniversary: '2021-05-06', contact_dates: contact,
      title: null, role: null, nickname: null, urls: [], instant_messages: [], categories: [], addresses: [],
      vcard: existingVCard, book_source: 'local', address_book_id: 'book-1',
    }] })
    .mockResolvedValueOnce({ rows: [result] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockClear();
});

describe('Contact REST PATCH legacy date synchronization', () => {
  it('clearing birthday removes its legacy labelled date while preserving custom dates', async () => {
    arrangeQuery([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Wedding', value: '2020-09-14' },
      { label: 'Anniversary', value: '2021-05-06' },
    ], { ...updatedContact, contactDates: [{ label: 'Wedding', value: '2020-09-14' }] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ birthday: null }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = findQuery('UPDATE contacts SET');
    expect(update[1][8]).toBeNull();
    expect(JSON.parse(stringParameter(update[1], 10))).toEqual([
      { label: 'Wedding', value: '2020-09-14' },
      { label: 'Anniversary', value: '2021-05-06' },
    ]);
    expect(stringParameter(update[1], 18)).not.toContain('BDAY');
    expect(stringParameter(update[1], 18)).toContain('ANNIVERSARY;TYPE=Anniversary:2021-05-06');
    expect(stringParameter(update[1], 18)).toContain('X-ABDATE;TYPE=Wedding:2020-09-14');
  });

  it('changing anniversary replaces its old legacy labelled date with exactly one new date', async () => {
    arrangeQuery([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Anniversary', value: '2021-05-06' },
    ], { ...updatedContact, birthday: '1990-01-02', anniversary: '2022-06-07', contactDates: [
      { label: 'Birthday', value: '1990-01-02' }, { label: 'Anniversary', value: '2022-06-07' },
    ] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anniversary: '2022-06-07' }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = findQuery('UPDATE contacts SET');
    const dates = JSON.parse(stringParameter(update[1], 10));
    expect(dates).toEqual([
      { label: 'Birthday', value: '1990-01-02' },
      { label: 'Anniversary', value: '2022-06-07' },
    ]);
    expect(stringParameter(update[1], 18).match(/ANNIVERSARY/g)).toHaveLength(1);
    expect(stringParameter(update[1], 18)).toContain('ANNIVERSARY;TYPE=Anniversary:2022-06-07');
    expect(stringParameter(update[1], 18)).not.toContain('2021-05-06');
  });

  it('keeps explicitly supplied contactDates authoritative when legacy fields are also supplied', async () => {
    arrangeQuery([{ label: 'Birthday', value: '1990-01-02' }], {
      ...updatedContact, birthday: '1990-01-02', contactDates: [{ label: 'Birthday', value: '1990-01-02' }],
    });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ birthday: '1991-01-02', contactDates: [{ label: 'Birthday', value: '1990-01-02' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ birthday: '1990-01-02' });
    const update = findQuery('UPDATE contacts SET');
    expect(update[1][8]).toBe('1990-01-02');
    expect(JSON.parse(stringParameter(update[1], 10))).toEqual([{ label: 'Birthday', value: '1990-01-02' }]);
    expect(stringParameter(update[1], 18).match(/BDAY/g)).toHaveLength(1);
    expect(stringParameter(update[1], 18)).toContain('BDAY;TYPE=Birthday:1990-01-02');
    expect(stringParameter(update[1], 18)).not.toContain('1991-01-02');
  });

  it('preserves a yearless birthday through REST editing without writing a fake SQL date', async () => {
    const dates = [{ label: 'Birthday', value: '--02-29' }];
    arrangeQuery(dates, { ...updatedContact, birthday: null, contactDates: dates });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactDates: dates }),
    });
    await new Promise(resolve => server.close(resolve));
    expect(response.status).toBe(200);
    const update = findQuery('UPDATE contacts SET');
    expect(update[1][8]).toBeNull();
    expect(JSON.parse(stringParameter(update[1], 10))).toEqual(dates);
    expect(stringParameter(update[1], 18)).toContain('BDAY;TYPE=Birthday:--02-29');
  });

  it('clears the legacy anniversary when authoritative contactDates omits it', async () => {
    arrangeQuery([
      { label: 'Anniversary', value: '2021-05-06' },
      { label: 'Wedding', value: '2020-09-14' },
    ], { ...updatedContact, anniversary: null, contactDates: [{ label: 'Wedding', value: '2020-09-14' }] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anniversary: '2022-06-07', contactDates: [{ label: 'Wedding', value: '2020-09-14' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    const update = findQuery('UPDATE contacts SET');
    expect(update[1][9]).toBeNull();
    expect(JSON.parse(stringParameter(update[1], 10))).toEqual([{ label: 'Wedding', value: '2020-09-14' }]);
    expect(stringParameter(update[1], 18)).not.toContain('ANNIVERSARY');
  });
});

describe('Contact REST labelled date validation', () => {
  it.each([
    ['Family\r\nX-Evil: injected'],
    ['Family"Other'],
  ])('rejects unsafe labelled dates on POST before any write query: %s', async label => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada', contactDates: [{ label, value: '2020-09-14' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD or --MM-DD dates' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT id FROM users');
  });

  it.each([
    ['Family\r\nX-Evil: injected'],
    ['Family"Other'],
  ])('rejects unsafe labelled dates on PATCH before loading or writing: %s', async label => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactDates: [{ label, value: '2020-09-14' }] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'contactDates must be an array of safe labelled YYYY-MM-DD or --MM-DD dates' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT id FROM users');
  });

  it('stores colon and semicolon labels exactly once and serializes them losslessly', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1' }] })
      .mockResolvedValueOnce({ rows: [{ ...updatedContact, contactDates: [
        { label: 'Family:Other', value: '2020-09-14' },
        { label: 'Family;Other', value: '2021-05-06' },
      ] }] })
      .mockResolvedValueOnce({ rows: [] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ada', contactDates: [
        { label: 'Family:Other', value: '2020-09-14' },
        { label: 'Family;Other', value: '2021-05-06' },
        { label: 'Family:Other', value: '2020-09-14' },
      ] }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(201);
    const insert = findQuery('INSERT INTO contacts');
    expect(JSON.parse(stringParameter(insert[1], 15))).toEqual([
      { label: 'Family:Other', value: '2020-09-14' },
      { label: 'Family;Other', value: '2021-05-06' },
    ]);
    expect(stringParameter(insert[1], 3)).toContain('X-ABDATE;TYPE="Family:Other":2020-09-14');
    expect(stringParameter(insert[1], 3)).toContain('X-ABDATE;TYPE="Family;Other":2021-05-06');
  });
});

describe('Google CSV import persistence', () => {
  it('persists normalized rich fields and every non-empty source column', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', source: 'local', visible: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const csv = [
      'First Name,Last Name,Nickname,Organization Name,Organization Title,Organization Department,Birthday,Event 1 - Label,Event 1 - Value,Address 1 - Label,Address 1 - Street,Address 1 - City,Website 1 - Label,Website 1 - Value,Labels,Custom Field 1 - Label,Custom Field 1 - Value',
      'Ada,Lovelace,Ada,Analytical Society,Mathematician,Research,1815-12-10,Anniversary,1835-01-01,Home,St James Square,London,Portfolio,https://example.test,Friends ::: VIP,Legacy ID,42',
    ].join('\n');
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/address-books/book-1/import/google-csv`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 1 });
    const insert = findQuery('INSERT INTO contacts');
    expect(insert[0]).toContain('google_fields');
    expect(JSON.parse(stringParameter(insert[1], 15))).toEqual([
      { label: 'Birthday', value: '1815-12-10' }, { label: 'Anniversary', value: '1835-01-01' },
    ]);
    expect(JSON.parse(stringParameter(insert[1], 19))).toEqual([{ value: 'https://example.test', type: 'portfolio' }]);
    expect(JSON.parse(stringParameter(insert[1], 20))).toEqual([]);
    expect(JSON.parse(stringParameter(insert[1], 22))).toEqual([{ type: 'home', pobox: '', extended: '', street: 'St James Square', locality: 'London', region: '', postalCode: '', country: '' }]);
    expect(JSON.parse(stringParameter(insert[1], 23))).toMatchObject({ 'Custom Field 1 - Label': 'Legacy ID', 'Custom Field 1 - Value': '42' });
  });
});

describe('an address book written by a source cannot be deleted', () => {
  // Deleting one would leave its integration collection with no local book (the foreign key
  // clears the link rather than failing), and the next sync would create the book again — so
  // the delete would appear to work and silently undo itself. The guard is what prevents it,
  // and it is pinned here because it is otherwise only reachable through the interface.
  for (const source of ['google', 'microsoft', 'carddav']) {
    it(`refuses to delete a ${source} book, deleting nothing`, async () => {
      query.mockReset();
      query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Imported', source }] });

      const server = createApp().listen(0);
      const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/address-books/book-1`, { method: 'DELETE' });
      await new Promise(resolve => server.close(resolve));

      expect(response.status).toBe(403);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM address_books'))).toBe(false);
    });
  }

  it('still deletes a local book when another local book remains', async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Personal', source: 'local' }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/address-books/book-1`, { method: 'DELETE' });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(204);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM address_books'))).toBe(true);
  });
});

describe('Address book DAV sharing (dav_mode)', () => {
  it('stores a DAV mode on a local address book', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Personal', source: 'local', visible: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Personal', source: 'local', visible: true, dav_mode: 'read_only' }] });

    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/address-books/book-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ davMode: 'read_only' }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dav_mode: 'read_only' });
    const update = findQuery('UPDATE address_books SET');
    expect(update[0]).toContain('dav_mode = COALESCE($3, dav_mode)');
    expect(stringParameter(update[1], 2)).toBe('read_only');
  });

  it('rejects an unknown DAV mode before touching the book', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/address-books/book-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ davMode: 'shared' }),
    });
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(400);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE address_books'))).toBe(false);
  });
});

describe('a contact whose book is written by a source refuses REST edits', () => {
  // The REST counterpart of the DAV rule pinned in davVisibility: the source is the
  // writer, so a local edit would be an apparent change the next sync discards. The
  // guard covers every non-local source, not only CardDAV, and that is what is pinned
  // here — including the original CardDAV behaviour it generalised.
  const contactRow = (bookSource: string) => ({
    id: 'contact-1', uid: 'contact-1', display_name: 'Ada', first_name: null, last_name: null,
    primary_email: null, emails: [], phones: [], organization: null, notes: null,
    birthday: null, anniversary: null, contact_dates: [],
    title: null, role: null, nickname: null, urls: [], instant_messages: [], categories: [], addresses: [],
    vcard: existingVCard, book_source: bookSource, address_book_id: 'book-1',
  });

  for (const source of ['carddav', 'google', 'microsoft']) {
    it(`refuses to edit a contact from a ${source} book, writing nothing`, async () => {
      query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [contactRow(source)] });

      const server = createApp().listen(0);
      const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Changed' }),
      });
      await new Promise(resolve => server.close(resolve));

      expect(response.status).toBe(403);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE contacts SET'))).toBe(false);
    });
  }

  for (const source of ['carddav', 'google', 'microsoft']) {
    it(`refuses to delete a contact from a ${source} book, deleting nothing`, async () => {
      query.mockReset();
      // `requireAuth` performs the session lookup first, so the source row is second.
      query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ source }] });

      const server = createApp().listen(0);
      const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, { method: 'DELETE' });
      await new Promise(resolve => server.close(resolve));

      expect(response.status).toBe(403);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM contacts'))).toBe(false);
    });
  }

  it('still allows editing a contact in a local book', async () => {
    // The mirror image: the guard must not become a blanket refusal.
    arrangeQuery([], updatedContact);
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Ada' }),
    });
    await new Promise(resolve => server.close(resolve));
    expect(response.status).toBe(200);
  });
});

describe('the read-only flag comes from the capability model, for every provider', () => {
  // The list and the single-contact read used to infer editability from one
  // adapter's source value (`ab.source = 'carddav'`), so a Google or Microsoft
  // book looked editable in the interface while the server refused the write.
  for (const [source, expected] of [['local', false], ['carddav', true], ['google', true], ['microsoft', true], ['ical_url', true]] as const) {
    it(`reports read_only=${expected} for a ${source} address book in the list`, async () => {
      query
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'contact-1', display_name: 'Ada', book_source: source }] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });
      const server = createApp().listen(0);
      const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts`);
      await new Promise(resolve => server.close(resolve));

      expect(response.status).toBe(200);
      const payload = await response.json() as { contacts: Array<{ read_only: boolean; book_source: string }> };
      expect(payload.contacts[0].read_only).toBe(expected);
      // The origin is still reported, so the interface can explain who owns it.
      expect(payload.contacts[0].book_source).toBe(source);
    });
  }

  it('reports read_only on a single contact read too', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'contact-1', display_name: 'Ada', book_source: 'google', vcard: null }] });
    const server = createApp().listen(0);
    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts/contact-1`);
    await new Promise(resolve => server.close(resolve));

    expect(response.status).toBe(200);
    expect((await response.json() as { read_only: boolean }).read_only).toBe(true);
  });
});
