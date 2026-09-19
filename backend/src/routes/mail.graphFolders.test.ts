// Folder management is IMAP-only. On a native account these four routes used to
// attempt an IMAP session and fail with a generic error, so an unsupported
// operation looked like a broken one. They now refuse explicitly and name the
// workaround the user has.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  graphCreateMailFolder: vi.fn(),
  graphRenameMailFolder: vi.fn(),
  graphDeleteMailFolder: vi.fn(),
  graphFolderIdForPath: vi.fn(),
  runProviderMutation: vi.fn(),
  syncGraphMailFoldersForAccount: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  emptyFolder: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    createFolder: mocks.createFolder,
    renameFolder: mocks.renameFolder,
    deleteFolder: mocks.deleteFolder,
    emptyFolder: mocks.emptyFolder,
    broadcast: vi.fn(),
    pluginFacade: {},
  },
}));

vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('../services/providers/microsoft/graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailSync.js')>();
  return { ...actual, graphFolderIdForPath: mocks.graphFolderIdForPath, syncGraphMailFoldersForAccount: mocks.syncGraphMailFoldersForAccount };
});
vi.mock('../services/providers/microsoft/graphMailMutations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailMutations.js')>();
  return {
    ...actual,
    graphCreateMailFolder: mocks.graphCreateMailFolder,
    graphRenameMailFolder: mocks.graphRenameMailFolder,
    graphDeleteMailFolder: mocks.graphDeleteMailFolder,
  };
});
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  mocks.graphFolderIdForPath.mockResolvedValue('graph-projects');
  mocks.syncGraphMailFoldersForAccount.mockResolvedValue([]);
});

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/mail${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('folder management on a native account refuses instead of failing like a bug', () => {
  // Every one of the four routes is implemented for a native account now, so none
  // still refuses. The loop is kept as the assertion that the refusal is gone
  // rather than deleted with the last case, because "no route here falls back to
  // IMAP" is the property this file exists for.
  it('no folder route refuses any more, and none of them reaches IMAP', async () => {
    for (const body of [
      { accountId: ACCOUNT_ID, name: 'Projects' },
      { accountId: ACCOUNT_ID, oldPath: 'A', newName: 'B' },
      { accountId: ACCOUNT_ID, path: 'A' },
    ]) {
      mocks.query.mockReset();
      // The account lookup comes first and must say Graph, or the route falls to IMAP.
      mocks.query.mockResolvedValue({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1', remote_id: 'graph-x' }], rowCount: 1 });
      mocks.graphCreateMailFolder.mockResolvedValue({ id: 'graph-x' });
      mocks.graphRenameMailFolder.mockResolvedValue({ id: 'graph-x' });
      mocks.graphDeleteMailFolder.mockResolvedValue(undefined);
      const path = body.name ? '/folders' : body.oldPath ? '/folders/rename' : '/folders/delete';
      const response = await post(path, body);
      expect(response.status, `${path} should not refuse`).not.toBe(501);
    }
    expect(mocks.createFolder).not.toHaveBeenCalled();
    expect(mocks.renameFolder).not.toHaveBeenCalled();
    expect(mocks.deleteFolder).not.toHaveBeenCalled();
  });

  it('leaves an IMAP account on the IMAP path', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'imap_smtp' }], rowCount: 1 });
    mocks.createFolder.mockResolvedValue(undefined);

    const response = await post('/folders', { accountId: ACCOUNT_ID, name: 'Projects' });
    expect(response.status).toBe(200);
    expect(mocks.createFolder).toHaveBeenCalled();
  });
});

describe('creating and renaming a folder on a native account', () => {
  it('creates it on the provider and discovers it, rather than writing the local row itself', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ remote_id: 'graph-projects' }], rowCount: 1 });   // graphFolderIdForPath after discovery
    mocks.graphCreateMailFolder.mockResolvedValue({ id: 'graph-projects', displayName: 'Projects' });

    const response = await post('/folders', { accountId: ACCOUNT_ID, name: 'Projects' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, folder: 'Projects' });
    expect(mocks.graphCreateMailFolder).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }), 'Projects');
    // Discovery produces the local row and its collection; the route must not insert one.
    expect(mocks.syncGraphMailFoldersForAccount).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT_ID }));
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO folders'))).toBe(false);
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it('refuses a nested folder on a native account rather than guessing a path', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });

    const response = await post('/folders', { accountId: ACCOUNT_ID, name: 'Projects', parentPath: 'INBOX' });
    expect(response.status).toBe(501);
    expect(mocks.graphCreateMailFolder).not.toHaveBeenCalled();
  });

  it('reports a provider refusal instead of a success the mailbox does not have', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    const { GraphApiError } = await import('../services/providers/microsoft/graphApiClient.js');
    mocks.graphCreateMailFolder.mockRejectedValue(new GraphApiError({ code: 'INSUFFICIENT_SCOPES', message: 'no', status: 403 }));

    const response = await post('/folders', { accountId: ACCOUNT_ID, name: 'Projects' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPES' });
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
  });
});

describe('deleting a folder on a native account', () => {
  it('removes it on the provider and then Inboxora\'s copy of it, as the IMAP path does', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ remote_id: 'graph-projects' }], rowCount: 1 });   // graphFolderIdForPath
    mocks.graphDeleteMailFolder.mockResolvedValue(undefined);

    const response = await post('/folders/delete', { accountId: ACCOUNT_ID, path: 'Projects' });
    expect(response.status).toBe(200);
    expect(mocks.graphDeleteMailFolder).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }), 'graph-projects');
    // The local cleanup mirrors the provider, exactly as the IMAP route does.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM folders'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(true);
    expect(mocks.deleteFolder).not.toHaveBeenCalled();
  });

  it('leaves the local copy alone when the provider refuses', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ remote_id: 'graph-inbox' }], rowCount: 1 });
    const { GraphApiError } = await import('../services/providers/microsoft/graphApiClient.js');
    mocks.graphDeleteMailFolder.mockRejectedValue(new GraphApiError({ code: 'OPERATION_FORBIDDEN', message: 'well-known', status: 400 }));

    const response = await post('/folders/delete', { accountId: ACCOUNT_ID, path: 'INBOX' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'OPERATION_FORBIDDEN' });
    // A local delete after a refused provider delete would be silent data loss.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM folders'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(false);
  });
});

describe('emptying a folder on a native account', () => {
  it('removes every message permanently on the provider, as the IMAP path does', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 })  // route account
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', provider_message_id: 'AAMkAD-1' }], rowCount: 1 });                                              // folder messages
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false });

    const response = await post('/folders/empty', { accountId: ACCOUNT_ID, path: 'Junk' });
    // The route answers as soon as the work is accepted; the removal happens after.
    expect(response.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 10));

    const [request] = mocks.runProviderMutation.mock.calls[0];
    expect(request.operation).toBe('delete');
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(true);
    expect(mocks.emptyFolder).not.toHaveBeenCalled();
  });

  it('leaves the local rows alone when the provider refuses, so the folder does not look empty', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', provider_message_id: 'AAMkAD-1' }], rowCount: 1 });
    mocks.runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-1', code: 'RESOURCE_NOT_FOUND', replayed: false });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await post('/folders/empty', { accountId: ACCOUNT_ID, path: 'Junk' });
    expect(response.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 10));

    // A local cleanup after a refused provider removal would report an empty folder
    // whose messages are still there.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(false);
    error.mockRestore();
  });
});
