// Filing a Microsoft Graph message — bulk move and bulk archive — is carried out by
// the provider, and the local row is re-homed onto the identity a Graph move returns.
// The IMAP bulk path is untouched, and the archive route's delete-and-re-insert CTE
// must never see a Graph row: it has no new UID to map, so the row would be deleted
// with nothing put back.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  runProviderMutation: vi.fn(),
  graphFolderIdForPath: vi.fn(),
  resolveArchiveFolder: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  resolveAllDraftsPaths: vi.fn(),
  isAllMailFolder: vi.fn(),
  adjustFolderCounts: vi.fn(),
  broadcast: vi.fn(),
  bulkMoveMessages: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    bulkMoveMessages: mocks.bulkMoveMessages,
    broadcast: mocks.broadcast,
    _guardMoveUid: mocks._guardMoveUid,
    _unguardMoveUid: mocks._unguardMoveUid,
    syncFolderOnDemand: vi.fn(),
    setFlag: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('../services/providers/microsoft/graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailSync.js')>();
  return { ...actual, graphFolderIdForPath: mocks.graphFolderIdForPath };
});
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mailUtils.js')>();
  return {
    ...actual,
    resolveArchiveFolder: mocks.resolveArchiveFolder,
    resolveTrashFolder: mocks.resolveTrashFolder,
    resolveAllTrashPaths: mocks.resolveAllTrashPaths,
    resolveAllDraftsPaths: mocks.resolveAllDraftsPaths,
    isAllMailFolder: mocks.isAllMailFolder,
    adjustFolderCounts: mocks.adjustFolderCounts,
  };
});

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    uid: 42,
    folder: 'INBOX',
    is_read: false,
    provider_message_id: 'AAMkAD-1',
    folder_mappings: null,
    ...overrides,
  };
}

function graphAccount() {
  return { id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' };
}

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.graphFolderIdForPath.mockResolvedValue('graph-archive');
  mocks.resolveArchiveFolder.mockResolvedValue('Archive');
  mocks.resolveTrashFolder.mockResolvedValue('Trash');
  mocks.resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  mocks.resolveAllDraftsPaths.mockResolvedValue(new Set<string>());
  mocks.isAllMailFolder.mockResolvedValue(false);
  mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2' }, replayed: false });
});

function arrangeOwnedMessages(message: Record<string, unknown> = {}) {
  mocks.query
    .mockResolvedValueOnce({ rows: [messageRow(message)], rowCount: 1 })                                  // owned messages
    .mockResolvedValueOnce({ rows: [{ id: 'folder-1' }], rowCount: 1 })                                  // destination exists
    .mockResolvedValueOnce({ rows: [{ ...graphAccount(), mail_transport: 'microsoft_graph' }], rowCount: 1 }); // account
}

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/mail${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('bulk-move files a Graph message through the provider', () => {
  it('moves it and re-homes the row onto the returned identity', async () => {
    arrangeOwnedMessages();

    const response = await post('/messages/bulk-move', { ids: [MESSAGE_ID], folder: 'Archive' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, moved: [MESSAGE_ID] });

    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', destinationFolderId: 'graph-archive' });
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: false });

    const update = mocks.query.mock.calls.find(([sql]) => String(sql).includes('provider_message_id = $3'));
    expect(update?.[1]?.[0]).toBe('Archive');
    expect(update?.[1]?.[2]).toBe('AAMkAD-2');
    // The IMAP bulk move is not involved for a native account.
    expect(mocks.bulkMoveMessages).not.toHaveBeenCalled();
    expect(mocks.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'Archive', accountId: ACCOUNT_ID }, 'user-1');
  });

  it('moves nothing when the destination is not a folder the account discovered', async () => {
    arrangeOwnedMessages();
    mocks.graphFolderIdForPath.mockResolvedValue(null);

    const response = await post('/messages/bulk-move', { ids: [MESSAGE_ID], folder: 'Nowhere' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, moved: [] });
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });

  it('reports only the messages the provider confirmed', async () => {
    arrangeOwnedMessages();
    mocks.runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-1', code: 'RESOURCE_NOT_FOUND', replayed: false });

    const response = await post('/messages/bulk-move', { ids: [MESSAGE_ID], folder: 'Archive' });
    expect(await response.json()).toEqual({ ok: true, moved: [] });
    // Nothing is re-homed, so the message stays where the user can still see it.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('provider_message_id = $3'))).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('leaves an IMAP account on the IMAP bulk path', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow({ provider_message_id: null })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'folder-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'imap_smtp' }], rowCount: 1 });
    mocks.bulkMoveMessages.mockResolvedValue({ uidMap: new Map([[42, 77]]), succeeded: [42], failed: [] });

    const response = await post('/messages/bulk-move', { ids: [MESSAGE_ID], folder: 'Archive' });
    expect(response.status).toBe(200);
    expect(mocks.bulkMoveMessages).toHaveBeenCalled();
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });
});

describe('bulk-archive keeps a Graph row out of the re-insert CTE', () => {
  it('archives through the provider and never deletes the row outright', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })                        // owned messages
      .mockResolvedValueOnce({ rows: [{ ...graphAccount() }], rowCount: 1 });              // account

    const response = await post('/messages/bulk-archive', { ids: [MESSAGE_ID] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, archived: [MESSAGE_ID], noArchiveFolder: [] });

    const [request] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ destinationFolderId: 'graph-archive' });
    // The CTE that deletes and re-inserts under a new UID must not see this row: a
    // Graph move has no new IMAP UID, so it would be deleted with nothing put back.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages WHERE id = ANY'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('RELOCATE_INSERT_COLS') || String(sql).includes('WITH deleted AS'))).toBe(false);
    // The row was re-homed instead.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('provider_message_id = $3'))).toBe(true);
    expect(mocks.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('reports an account with no archive folder rather than guessing one', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 });
    mocks.resolveArchiveFolder.mockResolvedValue(null);

    const response = await post('/messages/bulk-archive', { ids: [MESSAGE_ID] });
    expect(await response.json()).toEqual({ ok: true, archived: [], noArchiveFolder: [ACCOUNT_ID] });
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });
});

describe('bulk-delete keeps a Graph row out of the re-insert statement too', () => {
  it('moves a Graph message to Trash through the provider and re-homes it', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })                     // owned messages
      .mockResolvedValueOnce({ rows: [{ ...graphAccount() }], rowCount: 1 });           // account

    const response = await post('/messages/bulk-delete', { ids: [MESSAGE_ID] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, deleted: [MESSAGE_ID] });

    const [request] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', destinationFolderId: 'graph-archive' });
    // The CTE would delete the row and re-insert it under an IMAP UID the provider
    // does not have, so it must never see a Graph row.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages WHERE id = ANY'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('provider_message_id = $3'))).toBe(true);
    expect(mocks.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('removes a Graph message that is already in Trash, without the move path', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow({ folder: 'Trash' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...graphAccount() }], rowCount: 1 });

    const response = await post('/messages/bulk-delete', { ids: [MESSAGE_ID] });
    expect(response.status).toBe(200);
    expect(mocks.runProviderMutation.mock.calls[0][0].operation).toBe('delete');
    expect(mocks.bulkMoveMessages).not.toHaveBeenCalled();
    expect(mocks.graphFolderIdForPath).not.toHaveBeenCalled();
  });
});
