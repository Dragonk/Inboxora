import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const withTransaction = vi.fn(async (callback: (client: { query: unknown }) => unknown) => callback({ query: vi.fn(async () => ({ rows: [] })) }));
  return {
    query,
    withTransaction,
    resolveTarget: vi.fn(),
    resolveGoogleTarget: vi.fn(),
    writeContact: vi.fn(),
    personLinkForRow: vi.fn(),
    recordLink: vi.fn(async () => undefined),
    removeLink: vi.fn(async () => undefined),
  };
});

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../services/providerContactWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerContactWrites.js')>()),
  resolveContactWriteTarget: mocks.resolveTarget,
  writeGraphContact: vi.fn(),
  graphContactIdForLocalRow: vi.fn(),
  recordGraphContactLink: vi.fn(),
  removeGraphContactLink: vi.fn(),
}));
vi.mock('../services/providerGoogleWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerGoogleWrites.js')>()),
  resolveGoogleContactWriteTarget: mocks.resolveGoogleTarget,
  writeGoogleContact: mocks.writeContact,
  googlePersonLinkForLocalRow: mocks.personLinkForRow,
  recordGoogleContactLink: mocks.recordLink,
  removeGoogleContactLink: mocks.removeLink,
}));

import express from 'express';
import session from 'express-session';
import contactsRouter from './contacts.js';
import { listeningPort } from '../test/net.js';

const GOOGLE_TARGET = {
  kind: 'google' as const,
  connectionId: 'connection-1',
  collectionId: 'collection-1',
  collectionRemoteId: 'people/me',
  addressBookId: 'book-1',
};

const contactRow = {
  id: 'contact-1', uid: 'google-c1', display_name: 'Ada', first_name: null, last_name: null,
  primary_email: 'ada@example.test', emails: [{ value: 'ada@example.test', type: 'other', primary: true }],
  phones: [], organization: null, notes: null, birthday: null, anniversary: null, contact_dates: [],
  title: null, role: null, nickname: null, urls: [], instant_messages: [], categories: [], addresses: [],
  vcard: null, book_source: 'google', address_book_id: 'book-1',
};

const updatedContact = { id: 'contact-1', uid: 'google-c1', display_name: 'Changed' };

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

/** A refusal from the shared resolver is what makes the route ask whether this is a Google book. */
function resolveAsGoogle(): void {
  mocks.resolveTarget.mockResolvedValue({ kind: 'refused', status: 403, error: 'This contact is synced from an external source and is read-only' });
  mocks.resolveGoogleTarget.mockResolvedValue(GOOGLE_TARGET);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTarget.mockResolvedValue({ kind: 'local' });
  mocks.resolveGoogleTarget.mockResolvedValue({ kind: 'not_google' });
  mocks.writeContact.mockResolvedValue({ status: 'confirmed', providerContactId: 'people/c1', person: { resourceName: 'people/c1', etag: 'etag-1' } });
  mocks.personLinkForRow.mockResolvedValue({ resourceName: 'people/c1', etag: 'etag-1' });
  mocks.query.mockResolvedValue({ rows: [] });
});

describe('editing a Google contact writes to People first', () => {
  it('sends the etag the link stored, then updates the local projection', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });      // session lookup
    mocks.query.mockResolvedValueOnce({ rows: [contactRow] });            // contact + book
    mocks.query.mockResolvedValue({ rows: [updatedContact] });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(200);
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update', providerContactId: 'people/c1', etag: 'etag-1', localResourceId: 'contact-1',
    }));
    expect(ranQuery('UPDATE contacts SET')).toBe(true);
  });

  it('leaves the local row untouched when People refuses', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [contactRow] });
    mocks.writeContact.mockResolvedValueOnce({
      status: 'failed', failure: { status: 403, error: 'The provider refused this change', code: 'INSUFFICIENT_SCOPES' },
    });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_SCOPES' });
    expect(ranQuery('UPDATE contacts SET')).toBe(false);
  });

  it('refuses a contact that is not linked to its provider copy yet', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [contactRow] });
    mocks.personLinkForRow.mockResolvedValueOnce(null);

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(409);
    expect(mocks.writeContact).not.toHaveBeenCalled();
    expect(ranQuery('UPDATE contacts SET')).toBe(false);
  });

  it('reports a Google book this installation may not write with its own reason', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [contactRow] });
    mocks.resolveGoogleTarget.mockResolvedValue({ kind: 'refused', status: 403, error: 'Google Calendar and Contacts are switched off on this installation' });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'Google Calendar and Contacts are switched off on this installation' });
    expect(mocks.writeContact).not.toHaveBeenCalled();
  });
});

describe('deleting a Google contact writes to People first', () => {
  it('removes the provider contact, tombstones the link and deletes the local row', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ address_book_id: 'book-1' }] });
    mocks.query.mockResolvedValue({ rows: [{ address_book_id: 'book-1' }] });

    const response = await call('DELETE', '/contact-1');

    expect(response.status).toBe(200);
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'delete', providerContactId: 'people/c1', localResourceId: 'contact-1',
    }));
    expect(mocks.removeLink).toHaveBeenCalledWith(expect.objectContaining({ providerContactId: 'people/c1' }));
    expect(ranQuery('DELETE FROM contacts')).toBe(true);
  });

  it('treats a contact People no longer has as removed', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ address_book_id: 'book-1' }] });
    mocks.query.mockResolvedValue({ rows: [{ address_book_id: 'book-1' }] });
    mocks.writeContact.mockResolvedValueOnce({
      status: 'failed', failure: { status: 404, error: 'This item no longer exists at the provider', code: 'RESOURCE_NOT_FOUND' },
    });

    const response = await call('DELETE', '/contact-1');

    expect(response.status).toBe(200);
    expect(ranQuery('DELETE FROM contacts')).toBe(true);
  });
});

describe('creating a Google contact writes to People first', () => {
  it('creates at the provider, then stores the row under the provider identity', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });   // session lookup
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Google Contacts', source: 'google', visible: true, source_access: 'read_write', user_access: 'read_write' }] }); // book guard
    mocks.query.mockResolvedValueOnce({ rows: [] });                   // duplicate e-mail pre-check
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'contact-9' }] });// local insert

    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [{ value: 'ada@example.test' }],
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 'contact-9', providerContactId: 'people/c1' });
    expect(mocks.writeContact).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create', target: GOOGLE_TARGET }));
    // The version the create returned is recorded, so a later update can present it back to People.
    expect(mocks.recordLink).toHaveBeenCalledWith(expect.objectContaining({
      providerContactId: 'people/c1', localId: 'contact-9', etag: 'etag-1',
    }));
    // The local uid is derived from the resource name, so the next delta updates this row.
    const insert = (mocks.query.mock.calls as Array<[string, unknown[]]>).find(([sql]) => String(sql).includes('INSERT INTO contacts'));
    expect(insert?.[1]).toContain('google-c1');
  });

  it('refuses a duplicate e-mail before touching the provider', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Google Contacts', source: 'google', visible: true, source_access: 'read_write', user_access: 'read_write' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [{ value: 'ada@example.test' }],
    });

    expect(response.status).toBe(409);
    expect(mocks.writeContact).not.toHaveBeenCalled();
  });

  it('writes nothing locally when People refuses the create', async () => {
    resolveAsGoogle();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'book-1', name: 'Google Contacts', source: 'google', visible: true, source_access: 'read_write', user_access: 'read_write' }] });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.writeContact.mockResolvedValueOnce({ status: 'failed', failure: { status: 502, error: 'The provider did not confirm this change.', code: 'MUTATION_OUTCOME_UNKNOWN' } });

    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [{ value: 'ada@example.test' }],
    });

    expect(response.status).toBe(502);
    expect(ranQuery('INSERT INTO contacts')).toBe(false);
    expect(mocks.recordLink).not.toHaveBeenCalled();
  });
});

describe('a local address book keeps writing locally', () => {
  it('never asks about a Google collection the shared resolver already owns', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ ...contactRow, book_source: 'local' }] });
    mocks.query.mockResolvedValue({ rows: [updatedContact] });

    const response = await call('PATCH', '/contact-1', { displayName: 'Changed' });

    expect(response.status).toBe(200);
    expect(mocks.resolveGoogleTarget).not.toHaveBeenCalled();
    expect(mocks.writeContact).not.toHaveBeenCalled();
  });
});
