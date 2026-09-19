import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const withTransaction = vi.fn(async (callback: (client: { query: unknown }) => unknown) => callback({ query: vi.fn(async () => ({ rows: [] })) }));
  return {
    query,
    withTransaction,
    resolveTarget: vi.fn(),
    writeContact: vi.fn(),
    providerIdForRow: vi.fn(),
    recordLink: vi.fn(async () => undefined),
    removeLink: vi.fn(async () => undefined),
  };
});

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../services/providerContactWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerContactWrites.js')>()),
  resolveContactWriteTarget: mocks.resolveTarget,
  writeGraphContact: mocks.writeContact,
  graphContactIdForLocalRow: mocks.providerIdForRow,
  recordGraphContactLink: mocks.recordLink,
  removeGraphContactLink: mocks.removeLink,
}));

import express from 'express';
import session from 'express-session';
import contactsRouter from './contacts.js';
import { listeningPort } from '../test/net.js';

const query = mocks.query;

const GRAPH_TARGET = {
  kind: 'graph' as const,
  connectionId: 'connection-1',
  collectionId: 'collection-1',
  folderId: 'contacts',
  addressBookId: 'book-1',
};

const contactRow = {
  id: 'contact-1', uid: 'msgraph-AAMkAD-1', display_name: 'Ada', first_name: null, last_name: null,
  primary_email: 'ada@example.test', emails: [{ value: 'ada@example.test', type: 'other', primary: true }],
  phones: [], organization: null, notes: null, birthday: null, anniversary: null, contact_dates: [],
  title: null, role: null, nickname: null, urls: [], instant_messages: [], categories: [], addresses: [],
  vcard: null, book_source: 'microsoft', address_book_id: 'book-1',
};

const updatedContact = { id: 'contact-1', uid: 'msgraph-AAMkAD-1', display_name: 'Changed' };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.userId = 'user-1'; next(); });
  app.use('/api/contacts', contactsRouter);
  return app;
}

async function call(method: 'PATCH' | 'DELETE' | 'POST', path: string, body?: unknown) {
  const server = createApp().listen(0);
  const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/api/contacts${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  await new Promise(resolve => server.close(resolve));
  return { status: response.status, body: parsed };
}

function ranQuery(fragment: string): boolean {
  return (mocks.query.mock.calls as Array<[string]>).some(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue(GRAPH_TARGET);
  mocks.writeContact.mockResolvedValue({ status: 'confirmed', providerContactId: 'AAMkAD-1', contact: { id: 'AAMkAD-1' } });
  mocks.providerIdForRow.mockResolvedValue('AAMkAD-1');
  query.mockResolvedValue({ rows: [] });
});

describe('editing a Microsoft contact writes to Graph first', () => {
  it('patches the provider, then the local projection', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });          // session lookup
    query.mockResolvedValueOnce({ rows: [contactRow] });                // contact + book
    query.mockResolvedValue({ rows: [updatedContact] });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(200);
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update', providerContactId: 'AAMkAD-1', userId: 'user-1',
    }));
    expect(ranQuery('UPDATE contacts SET')).toBe(true);
  });

  it('leaves the local row untouched when the provider refuses', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [contactRow] });
    mocks.writeContact.mockResolvedValueOnce({
      status: 'failed', failure: { status: 403, error: 'The provider refused this change', code: 'INSUFFICIENT_SCOPES' },
    });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_SCOPES' });
    expect(ranQuery('UPDATE contacts SET')).toBe(false);
  });

  it('refuses a contact that is not linked to its provider copy yet', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [contactRow] });
    mocks.providerIdForRow.mockResolvedValueOnce(null);

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(409);
    expect(mocks.writeContact).not.toHaveBeenCalled();
    expect(ranQuery('UPDATE contacts SET')).toBe(false);
  });
});

describe('deleting a Microsoft contact writes to Graph first', () => {
  it('removes the provider contact, tombstones the link and deletes the local row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [{ address_book_id: 'book-1' }] });
    query.mockResolvedValue({ rows: [{ address_book_id: 'book-1' }] });

    const response = await call('DELETE', '/contact-1');

    expect(response.status).toBe(200);
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({ operation: 'delete', providerContactId: 'AAMkAD-1' }));
    expect(mocks.removeLink).toHaveBeenCalledWith(expect.objectContaining({ providerContactId: 'AAMkAD-1' }));
    expect(ranQuery('DELETE FROM contacts')).toBe(true);
  });

  it('treats a contact the provider no longer has as removed', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [{ address_book_id: 'book-1' }] });
    query.mockResolvedValue({ rows: [{ address_book_id: 'book-1' }] });
    mocks.writeContact.mockResolvedValueOnce({
      status: 'failed', failure: { status: 404, error: 'This contact no longer exists at the provider', code: 'RESOURCE_NOT_FOUND' },
    });

    const response = await call('DELETE', '/contact-1');

    expect(response.status).toBe(200);
    expect(ranQuery('DELETE FROM contacts')).toBe(true);
  });
});

describe('creating a Microsoft contact writes to Graph first', () => {
  it('creates at the provider, then stores the row under the provider identity', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });   // session lookup
    query.mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Microsoft Contacts', source: 'microsoft', visible: true, source_access: 'read_write', user_access: 'read_write' }] }); // book guard
    query.mockResolvedValueOnce({ rows: [] });                   // duplicate e-mail pre-check
    query.mockResolvedValueOnce({ rows: [{ id: 'contact-9' }] });// local insert

    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [{ value: 'ada@example.test' }],
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 'contact-9', providerContactId: 'AAMkAD-1' });
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create' }));
    expect(mocks.recordLink).toHaveBeenCalledWith(expect.objectContaining({ providerContactId: 'AAMkAD-1', localId: 'contact-9' }));
    // The local uid is derived from the provider id, so the next delta updates this row instead of
    // inserting a second copy of the same contact.
    const insert = (mocks.query.mock.calls as Array<[string, unknown[]]>).find(([sql]) => String(sql).includes('INSERT INTO contacts'));
    expect(insert?.[1]).toContain('msgraph-AAMkAD-1');
  });

  it('refuses a duplicate e-mail before touching the provider', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Microsoft Contacts', source: 'microsoft', visible: true, source_access: 'read_write', user_access: 'read_write' }] });
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [{ value: 'ada@example.test' }],
    });

    expect(response.status).toBe(409);
    expect(mocks.writeContact).not.toHaveBeenCalled();
  });
});
