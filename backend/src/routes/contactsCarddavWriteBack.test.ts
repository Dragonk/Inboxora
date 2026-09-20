import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listeningPort } from '../test/net.js';
import type { Server } from 'node:http';

/**
 * Managing an external CardDAV address book from the web interface.
 *
 * A CardDAV client's `PUT`/`DELETE` already reached the source; the contacts page did not, so a book the user
 * had enabled write-back for was reported writable and then refused. These cases pin the web path onto the
 * same write-back client for create, update and delete.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveTarget: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn(async (callback: (client: { query: typeof mocks.query }) => unknown) => callback({ query: mocks.query })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/providers/carddavWriteBack.js', () => ({
  putCarddavContact: mocks.put,
  deleteCarddavContact: mocks.remove,
}));
vi.mock('../services/providerContactWrites.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerContactWrites.js')>()),
  resolveContactWriteTarget: mocks.resolveTarget,
}));
vi.mock('../services/providerGoogleWrites.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/providerGoogleWrites.js')>()),
  resolveGoogleContactWriteTarget: vi.fn(async () => ({ kind: 'not_google' })),
}));

import express from 'express';
import contactsRouter from './contacts.js';

const CARDDAV_TARGET = {
  kind: 'carddav' as const,
  collectionId: 'collection-1',
  addressBookId: 'book-1',
  externalUrl: 'https://dav.example.test/addressbooks/user/',
};

const CARD = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:uid-1', 'FN:Ada Lovelace', 'N:Lovelace;Ada;;;',
  'EMAIL;TYPE=INTERNET:ada@example.test', 'END:VCARD'].join('\r\n');

let server: Server;
let base = '';

beforeEach(async () => {
  // `resetAllMocks`, not `clearAllMocks`: a queued `mockResolvedValueOnce` from an earlier case would
  // otherwise survive into the next one and answer a query that expects the real arrangement.
  vi.resetAllMocks();
  mocks.resolveTarget.mockResolvedValue(CARDDAV_TARGET);
  mocks.put.mockResolvedValue({ status: 'confirmed', created: true, etag: 'etag-new' });
  mocks.remove.mockResolvedValue({ status: 'confirmed', created: false });
  mocks.query.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    // The address book the capability model resolves, then whatever the case arranged for.
    if (text.includes('address_books') || text.includes('FROM contacts')) {
      return { rows: [{ id: 'contact-1', uid: 'uid-1', user_id: 'user-1', address_book_id: 'book-1', vcard: CARD, etag: 'etag-1', book_source: 'carddav', emails: [], phones: [] }] };
    }
    return { rows: [] };
  });
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/contacts', contactsRouter);
    await new Promise<void>((resolve, reject) => { server = app.listen(0, () => resolve()); server.once('error', reject); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  }
});

const call = (method: string, path: string, body?: unknown) => fetch(`${base}/api/contacts${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('creating a contact in a write-enabled CardDAV book', () => {
  it('forwards the card to the source and answers with the projected row', async () => {
    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
      emails: [{ value: 'ada@example.test', primary: true }], phones: [],
    });

    expect(response.status).toBe(201);
    expect(mocks.put).toHaveBeenCalledOnce();
    const write = mocks.put.mock.calls[0]?.[0] as { method: string; exists: boolean; filename: string; vcard: string; book: { external_url: string } };
    expect(write).toMatchObject({ method: 'PUT', exists: false, book: { external_url: 'https://dav.example.test/addressbooks/user/' } });
    expect(write.filename).toMatch(/\.vcf$/);
    expect(write.vcard).toContain('FN:Ada Lovelace');
  });

  it('reports a source refusal instead of writing the card locally', async () => {
    mocks.put.mockResolvedValueOnce({ status: 'permanent', created: false, code: 'FORBIDDEN' });
    const response = await call('POST', '/', {
      addressBookId: 'book-1', displayName: 'Ada', emails: [], phones: [],
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO contacts'))).toBe(false);
  });
});

describe('editing and deleting a contact in a write-enabled CardDAV book', () => {
  it('presents the stored entity-tag so a card changed at the source is not overwritten', async () => {
    const response = await call('PATCH', '/contact-1', { displayName: 'Ada L.', emails: [], phones: [] });

    expect(response.status).toBe(200);
    const write = mocks.put.mock.calls[0]?.[0] as { exists: boolean; localRevision: string; uid: string; vcard: string };
    expect(write).toMatchObject({ exists: true, localRevision: 'etag-1', uid: 'uid-1' });
    expect(write.vcard).toContain('FN:Ada L.');
  });

  it('reports a precondition failure as a conflict', async () => {
    mocks.put.mockResolvedValueOnce({ status: 'conflict', created: false, code: 'PRECONDITION_FAILED' });
    const response = await call('PATCH', '/contact-1', { displayName: 'Ada L.', emails: [], phones: [] });

    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('deletes at the source and leaves the projection to the write-back client', async () => {
    const response = await call('DELETE', '/contact-1');

    expect(response.status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', filename: 'uid-1.vcf', uid: 'uid-1', exists: true, localRevision: 'etag-1' }));
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM contacts'))).toBe(false);
  });
});
