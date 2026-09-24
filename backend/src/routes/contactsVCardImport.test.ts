import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../services/db.js', () => ({
  query: mocks.query,
  withTransaction: async (fn: (client: { query: typeof mocks.query }) => unknown) => fn({ query: mocks.query }),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { session?: { userId?: string } }, _res: unknown, next: () => void) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

import contactsRouter from './contacts.js';

let server: Server;
let base = '';

const CARD = (uid: string, name: string, email: string) => [
  'BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${name}`, `EMAIL;TYPE=work:${email}`,
  'TEL;TYPE=cell:+48 600 000 000', 'ORG:Analytical Engines', 'BDAY:1815-12-10', 'END:VCARD',
].join('\r\n');

const importVCard = (body: unknown) => fetch(`${base}/api/contacts/address-books/book-1/import/vcard`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

function queryCallsMatching(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

beforeAll(async () => {
  const app = express();
  // The server's global JSON limit; the route's own guard is what rejects an
  // oversized file, so the harness must not reject it first.
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/contacts', contactsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.query.mockReset();
  // `requireLocalAddressBook` looks the book up first; every later statement is an
  // insert or the sync-token bump.
  mocks.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM address_books')) {
      return { rows: [{ id: 'book-1', name: 'Personal', source: 'local', visible: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe('POST /api/contacts/address-books/:id/import/vcard', () => {
  it('rejects provider-backed books instead of writing a local projection', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM address_books')) {
        return { rows: [{ id: 'book-1', name: 'Synced', source: 'google', visible: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const response = await importVCard({ vcard: CARD('remote-1', 'Remote', 'remote@example.test') });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Only local address books accept imports' });
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('imports every card and keys it on the vCard UID', async () => {
    const response = await importVCard({ vcard: `${CARD('ada-1', 'Ada Lovelace', 'ada@example.test')}\r\n${CARD('grace-1', 'Grace Hopper', 'grace@example.test')}` });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 2 });

    const inserts = queryCallsMatching('INSERT INTO contacts');
    expect(inserts).toHaveLength(2);
    // The identity is the UID, so a re-import of the same file updates rather than
    // duplicating. The CSV import cannot do this: a CSV has no stable identity.
    expect(String(inserts[0][0])).toContain('ON CONFLICT (address_book_id, uid) DO UPDATE');
    expect(inserts.map(call => (call[1] as unknown[])[2])).toEqual(['ada-1', 'grace-1']);
    // The card's own fields are projected, not just the raw text.
    const params = inserts[0][1] as unknown[];
    expect(params[5]).toBe('Ada Lovelace');
    expect(params[8]).toBe('ada@example.test');
    expect(JSON.stringify(params[9])).toContain('ada@example.test');
    expect(String(params[3])).toContain('UID:ada-1');
    expect(queryCallsMatching('UPDATE address_books SET sync_token')).toHaveLength(1);
  });

  it('gives a card without a UID a stable identity instead of rejecting it', async () => {
    const response = await importVCard({ vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Uid\r\nEMAIL:a@b.test\r\nEND:VCARD' });
    expect(response.status).toBe(201);
    const params = (queryCallsMatching('INSERT INTO contacts')[0]?.[1] ?? []) as unknown[];
    expect(String(params[2])).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(params[3])).toContain('UID:');
  });

  it('skips a block that carries no usable contact data', async () => {
    const response = await importVCard({ vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:empty-1\r\nEND:VCARD' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No contacts found in the vCard file' });
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('rejects an empty or oversized body before touching the book', async () => {
    expect((await importVCard({ vcard: '' })).status).toBe(400);
    expect((await importVCard({ vcard: 'x'.repeat(900_001) })).status).toBe(400);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
    expect(queryCallsMatching('FROM address_books')).toHaveLength(0);
  });

  it('refuses a body that contains no card, importing nothing', async () => {
    const response = await importVCard({ vcard: 'name,email\nAda,ada@example.test' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No contacts found in the vCard file' });
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });

  it('refuses to import into a book that is not local', async () => {
    mocks.query.mockImplementation(async (sql: string) => (
      String(sql).includes('FROM address_books')
        ? { rows: [{ id: 'book-1', name: 'Google Contacts', source: 'google', visible: true }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    ));
    const response = await importVCard({ vcard: CARD('ada-1', 'Ada Lovelace', 'ada@example.test') });
    expect(response.status).toBe(403);
    expect(queryCallsMatching('INSERT INTO contacts')).toHaveLength(0);
  });
});
