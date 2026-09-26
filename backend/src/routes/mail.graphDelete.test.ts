// Deleting a Microsoft Graph message is the same product decision as deleting an
// IMAP one — a draft and a message already in Trash are removed for good, anything
// else goes to Trash — but it is carried out by the provider. These cases assert the
// decision, the provider call and the local row's new identity after a move.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  projectMove: vi.fn<typeof import('../services/providers/microsoft/graphMailContinuity.js').projectGraphMove>(),
  runProviderMutation: vi.fn(),
  graphFolderIdForPath: vi.fn(),
  resolveTrashFolder: vi.fn(),
  resolveAllDraftsPaths: vi.fn(),
  resolveAllTrashPaths: vi.fn(),
  getDeleteStrategy: vi.fn(),
  broadcast: vi.fn(),
  permanentDeleteMessage: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: mocks.broadcast,
    permanentDeleteMessage: mocks.permanentDeleteMessage,
    moveMessage: vi.fn<(...args: never[]) => Promise<number | null>>(),
    setFlag: vi.fn(),
    fetchMessageBody: vi.fn(),
    fetchAttachment: vi.fn(),
    noteUserActivity: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
// SQL and rollback behavior are exercised with PostgreSQL in
// graphMailContinuity.integration.test.ts. These route tests keep the real
// Graph mover and assert its transaction/projector boundary explicitly.
vi.mock('../services/providers/microsoft/graphMailContinuity.js', () => ({
  projectGraphMove: mocks.projectMove,
}));
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
    resolveTrashFolder: mocks.resolveTrashFolder,
    resolveAllDraftsPaths: mocks.resolveAllDraftsPaths,
    resolveAllTrashPaths: mocks.resolveAllTrashPaths,
    getDeleteStrategy: mocks.getDeleteStrategy,
  };
});

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';
import { providerUidForGraphMessage } from '../services/providers/microsoft/graphMail.js';

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    uid: 42,
    folder: 'INBOX',
    provider_message_id: 'AAMkAD-1',
    is_read: false,
    message_id: null,
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
  mocks.withTransaction.mockImplementation(async (
    run: (client: { query: typeof mocks.query }) => Promise<unknown>,
  ) => run({ query: mocks.query }));
  mocks.projectMove.mockResolvedValue({
    moved: true, uid: providerUidForGraphMessage('AAMkAD-2'),
  });
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.resolveTrashFolder.mockResolvedValue('Trash');
  mocks.resolveAllDraftsPaths.mockResolvedValue(new Set<string>());
  mocks.resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  mocks.getDeleteStrategy.mockReturnValue({ action: 'move' });
  mocks.graphFolderIdForPath.mockResolvedValue('graph-deleteditems');
});

function arrangeDelete(message: Record<string, unknown> = {}) {
  mocks.query
    .mockResolvedValueOnce({ rows: [messageRow(message)], rowCount: 1 })   // message lookup
    .mockResolvedValueOnce({ rows: [graphAccount()], rowCount: 1 });       // account lookup
}

const deleteMessage = () => fetch(`${base}/api/mail/messages/${MESSAGE_ID}`, { method: 'DELETE' });

/** Assert that the real mover delegates exactly the canonical identity. */
function expectProjectedMove(targetPath: string, rowId = MESSAGE_ID, sourceId = 'AAMkAD-1') {
  expect(mocks.withTransaction).toHaveBeenCalled();
  expect(mocks.projectMove).toHaveBeenCalledTimes(1);
  expect(mocks.projectMove).toHaveBeenCalledWith({ query: mocks.query }, {
    accountId: ACCOUNT_ID, connectionId: 'connection-1', rowId,
    sourceId, targetId: 'AAMkAD-2', targetPath,
  });
}

describe('a Graph message goes to Trash through the provider', () => {
  it('moves it to the deleted-items folder and re-homes the local row onto its new identity', async () => {
    arrangeDelete();
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2', parentFolderId: 'graph-deleteditems' }, replayed: false });

    const response = await deleteMessage();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', destinationFolderId: 'graph-deleteditems' });
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: false });

    expectProjectedMove('Trash');
    // The route must not repeat the projector's work or delete UID collisions.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(false);
    expect(mocks.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'INBOX', accountId: ACCOUNT_ID }, 'user-1');
  });

  it('does not report Trash success when the local projection was not applied', async () => {
    arrangeDelete();
    mocks.runProviderMutation.mockResolvedValue({
      status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2' }, replayed: false,
    });
    mocks.projectMove.mockResolvedValue({ moved: false, uid: null });

    const response = await deleteMessage();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'MUTATION_OUTCOME_UNKNOWN' });
    expectProjectedMove('Trash');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM messages'))).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('removes it permanently when it is already in Trash', async () => {
    arrangeDelete({ folder: 'Trash' });
    mocks.getDeleteStrategy.mockReturnValue({ action: 'expunge' });
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-2', replayed: false });

    const response = await deleteMessage();
    expect(response.status).toBe(200);
    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.operation).toBe('delete');
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1' });
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: false });
    const removed = mocks.query.mock.calls.find(([sql]) => String(sql).trim().startsWith('DELETE FROM messages WHERE id = $1'));
    expect(removed).toBeDefined();
  });

  it('removes a draft for good rather than trashing it', async () => {
    arrangeDelete({ folder: 'Drafts' });
    mocks.resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-3', replayed: false });

    const response = await deleteMessage();
    expect(response.status).toBe(200);
    expect(mocks.runProviderMutation.mock.calls[0][0].operation).toBe('delete');
    expect(mocks.graphFolderIdForPath).not.toHaveBeenCalled();
  });

  it('refuses when the account has no Trash folder to move to', async () => {
    arrangeDelete();
    mocks.resolveTrashFolder.mockResolvedValue(null);
    mocks.resolveAllTrashPaths.mockResolvedValue(new Set<string>());
    mocks.getDeleteStrategy.mockReturnValue({ action: 'no_trash' });

    const response = await deleteMessage();
    expect(response.status).toBe(422);
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });

  it('refuses when the destination path is not a folder the account discovered', async () => {
    arrangeDelete();
    mocks.graphFolderIdForPath.mockResolvedValue(null);

    const response = await deleteMessage();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });

  it('keeps the local row where it was when the provider refuses the delete', async () => {
    arrangeDelete();
    mocks.runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-4', code: 'RESOURCE_NOT_FOUND', replayed: false });

    const response = await deleteMessage();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).trim().startsWith('DELETE FROM messages WHERE id = $1'))).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('does not claim success when the outcome is unknown', async () => {
    arrangeDelete();
    mocks.runProviderMutation.mockResolvedValue({ status: 'outcome_unknown', operationId: 'op-5', code: 'MUTATION_OUTCOME_UNKNOWN', replayed: false });

    const response = await deleteMessage();
    expect(response.status).toBe(502);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).trim().startsWith('DELETE FROM messages WHERE id = $1'))).toBe(false);
  });

  it('leaves an IMAP account on the IMAP path', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow({ provider_message_id: null })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'imap_smtp' }], rowCount: 1 });
    const { imapManager } = await import('../index.js');
    vi.mocked(imapManager.moveMessage).mockResolvedValue(77);

    const response = await deleteMessage();
    expect(response.status).toBe(200);
    expect(vi.mocked(imapManager.moveMessage)).toHaveBeenCalled();
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
  });
});
