import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRAPH_CONTACTS_TARGET } from './graphContacts.js';
import { GraphApiError } from './graphApiClient.js';
import { syncGraphContacts } from './graphContactsSync.js';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  fetchPage: vi.fn(),
  query: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock('./graphContacts.js', async importOriginal => ({
  ...await importOriginal<typeof import('./graphContacts.js')>(),
  discoverGraphContactFolders: mocks.discover,
  fetchContactsPage: mocks.fetchPage,
}));
vi.mock('../../db.js', () => ({
  withTransaction: async (run: (client: { query: typeof mocks.query }) => unknown) => run({ query: mocks.query }),
}));
vi.mock('../../providerTokenService.js', () => ({ readGrantForUser: async () => null }));
vi.mock('../../syncCoordinator.js', () => ({
  ensureSyncState: async () => 'state',
  acquireSyncLease: mocks.acquire,
  readSyncState: async () => ({ cursor: null }),
  withFencedSyncLease: async (input: { run: (client: { query: typeof mocks.query }) => unknown }) => input.run({ query: mocks.query }),
  commitSyncCheckpoint: async () => true,
  finishSyncRun: async () => true,
  releaseSyncLease: async () => true,
  failSyncRun: async () => true,
  SyncLeaseLostError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT id, local_address_book_id')) {
      return { rows: [{ id: `collection:${params[1]}`, local_address_book_id: `book:${params[1]}` }] };
    }
    return { rows: [] };
  });
  mocks.acquire.mockResolvedValue({ generation: 1 });
  mocks.fetchPage.mockResolvedValue({ contacts: [], nextLink: null, deltaLink: null });
});

describe('Graph contacts target isolation', () => {
  it.each(['Contacts', 'Kontakte', 'First arbitrary folder'])('syncs the explicit default separately from %s', async displayName => {
    mocks.discover.mockResolvedValue([{ id: 'arbitrary-id', displayName }]);
    const result = await syncGraphContacts({ userId: 'user', connectionId: 'connection' });
    expect(mocks.fetchPage.mock.calls.map(call => call[1])).toEqual([
      { defaultContacts: true, nextLink: null, deltaLink: null, top: 200 },
      { folderId: 'arbitrary-id', nextLink: null, deltaLink: null, top: 200 },
    ]);
    expect(result.books.map(book => book.addressBookId)).toEqual([`book:${DEFAULT_GRAPH_CONTACTS_TARGET}`, 'book:arbitrary-id']);
    expect(mocks.acquire.mock.calls.map(call => call[1].owner)).toEqual([
      `graph-contacts:connection:${DEFAULT_GRAPH_CONTACTS_TARGET}`, 'graph-contacts:connection:arbitrary-id',
    ]);
  });

  it.each(['contacts_book_primary_email_idx', 'contacts_address_book_primary_email_idx', 'contacts_address_book_id_uid_key'])('classifies only historical email uniqueness violations: %s', async constraint => {
    mocks.discover.mockResolvedValue([{ id: 'folder', displayName: 'Contacts' }]);
    mocks.fetchPage.mockResolvedValueOnce({ contacts: [], nextLink: null, deltaLink: null })
      .mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: '23505', constraint }));
    const result = await syncGraphContacts({ userId: 'user', connectionId: 'connection' });
    const emailConstraint = constraint !== 'contacts_address_book_id_uid_key';
    expect(result.errors).toEqual([{ folderId: 'folder', code: emailConstraint ? 'CONTACT_EMAIL_COLLISION' : 'INTERNAL_ERROR', stage: emailConstraint ? 'db-project' : 'provider-request' }]);
    expect(result.books).toHaveLength(1);
    expect(result.addressBookId).toBe(`book:${DEFAULT_GRAPH_CONTACTS_TARGET}`);
  });

  it('still reads default contacts when discovery fails', async () => {
    mocks.discover.mockRejectedValue(new GraphApiError({ code: 'UPSTREAM_UNAVAILABLE', message: 'unavailable', status: 503 }));
    const result = await syncGraphContacts({ userId: 'user', connectionId: 'connection' });
    expect(mocks.fetchPage).toHaveBeenCalledExactlyOnceWith(expect.anything(), { defaultContacts: true, nextLink: null, deltaLink: null, top: 200 });
    expect(result).toMatchObject({ addressBookId: `book:${DEFAULT_GRAPH_CONTACTS_TARGET}`, incomplete: true, errors: [{ folderId: 'discovery', stage: 'discovery', code: 'UPSTREAM_UNAVAILABLE' }] });
  });
});
