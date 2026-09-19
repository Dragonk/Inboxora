import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), runProviderMutation: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn() }));

vi.mock('./db.js', () => ({ query: mocks.query }));
vi.mock('./providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('./providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'ms-client', clientSecret: 'ms-secret', redirectUri: '', tenantId: 'common' }),
}));
// The Graph calls themselves are covered by the adapter's own tests; this suite is about which writer
// owns a book and how a provider answer becomes a response.
vi.mock('./providers/microsoft/graphContactWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers/microsoft/graphContactWrites.js')>()),
  createGraphContact: mocks.create,
  patchGraphContact: mocks.patch,
  deleteGraphContact: mocks.remove,
}));

import {
  contactWriteFailure,
  graphContactIdForLocalRow,
  localUidForGraphContact,
  resolveContactWriteTarget,
  writeGraphContact,
} from './providerContactWrites.js';

const book = (overrides: Record<string, unknown> = {}) => ({
  id: 'book-1', source: 'local', collection_id: null, remote_id: null, connection_id: null,
  source_access: null, user_access: null, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { contact: { id: 'contact-7' } } });
});

describe('which writer owns an address book', () => {
  it('treats a book with no collection row as local', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [book()] });
    await expect(resolveContactWriteTarget('user-1', 'book-1')).resolves.toEqual({ kind: 'local' });
  });

  it('refuses a provider book whose origin does not permit writes', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [book({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'contacts',
      connection_id: 'connection-1', source_access: 'read_only', user_access: 'read_write',
    })] });
    await expect(resolveContactWriteTarget('user-1', 'book-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });

  it('refuses a provider book the user has not enabled, even though the origin would allow it', async () => {
    // This is the "a read-only collection stays read-only once writes exist" rule: learning to write does
    // not write anything until the user asks.
    mocks.query.mockResolvedValueOnce({ rows: [book({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'contacts',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'source',
    })] });
    await expect(resolveContactWriteTarget('user-1', 'book-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });

  it('resolves a write-enabled Microsoft book to its connection and folder', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [book({
      source: 'microsoft', collection_id: 'collection-1', remote_id: 'contacts',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write',
    })] });
    await expect(resolveContactWriteTarget('user-1', 'book-1')).resolves.toEqual({
      kind: 'graph', connectionId: 'connection-1', collectionId: 'collection-1', folderId: 'contacts', addressBookId: 'book-1',
    });
  });

  it('refuses a source whose write path does not exist in this route', async () => {
    // A CardDAV book with write-back enabled is written by the DAV route, not by a local edit here.
    mocks.query.mockResolvedValueOnce({ rows: [book({
      source: 'carddav', collection_id: 'collection-1', remote_id: 'contacts',
      connection_id: 'connection-1', source_access: 'read_write', user_access: 'read_write',
    })] });
    await expect(resolveContactWriteTarget('user-1', 'book-1')).resolves.toMatchObject({ kind: 'refused', status: 403 });
  });
});

describe('a provider answer becomes a response', () => {
  it('maps every mutation status honestly', () => {
    expect(contactWriteFailure({ status: 'conflict', code: 'CONFLICT' })).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(contactWriteFailure({ status: 'permanent', code: 'RESOURCE_NOT_FOUND' })).toMatchObject({ status: 404 });
    expect(contactWriteFailure({ status: 'permanent', code: 'INSUFFICIENT_SCOPES' })).toMatchObject({ status: 403 });
    expect(contactWriteFailure({ status: 'retryable', code: 'RATE_LIMITED', retryAfterSeconds: 30 }))
      .toMatchObject({ status: 503, retryAfterSeconds: 30 });
    expect(contactWriteFailure({ status: 'pending' })).toMatchObject({ status: 503 });
    expect(contactWriteFailure({ status: 'outcome_unknown' })).toMatchObject({ status: 502, code: 'MUTATION_OUTCOME_UNKNOWN' });
  });
});

describe('running a contact write through the journal', () => {
  const target = { kind: 'graph' as const, connectionId: 'connection-1', collectionId: 'collection-1', folderId: 'contacts', addressBookId: 'book-1' };

  it('reports the provider identity a create returned', async () => {
    const outcome = await writeGraphContact({
      userId: 'user-1', target, operation: 'create',
      contact: { displayName: 'Ada', emails: [{ value: 'ada@example.test' }] },
    });
    expect(outcome).toMatchObject({ status: 'confirmed', providerContactId: 'contact-7' });
    const [request, adapter] = mocks.runProviderMutation.mock.calls[0] as [Record<string, unknown>, { resourceType: string; idempotent: boolean }];
    expect(request).toMatchObject({ channel: 'web', operation: 'create', connectionId: 'connection-1', collectionId: 'collection-1' });
    expect(adapter).toMatchObject({ resourceType: 'contact', idempotent: false });
  });

  it('does not report success when the provider refused', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'retryable', operationId: 'op-1', replayed: false, code: 'RATE_LIMITED' });
    const outcome = await writeGraphContact({ userId: 'user-1', target, operation: 'update', providerContactId: 'contact-7' });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 503, code: 'RATE_LIMITED' } });
  });

  it('refuses to call a create confirmed without an identity', async () => {
    mocks.runProviderMutation.mockResolvedValueOnce({ status: 'confirmed', operationId: 'op-1', replayed: false, value: { contact: null } });
    const outcome = await writeGraphContact({
      userId: 'user-1', target, operation: 'create',
      contact: { displayName: 'Ada' },
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: { status: 502, code: 'CONTACT_ID_MISSING' } });
  });

  it('derives the local uid from the provider id, so a later sync updates the same row', () => {
    expect(localUidForGraphContact('AAMkAD-1')).toBe('msgraph-AAMkAD-1');
  });

  it('reads the provider id from an active link only', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ object_remote_id: 'contact-7' }] });
    await expect(graphContactIdForLocalRow('user-1', 'collection-1', 'local-1')).resolves.toBe('contact-7');
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'active'");
    expect(params).toEqual(['collection-1', 'user-1', 'local-1']);
  });
});
