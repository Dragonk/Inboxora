// Marking a Microsoft Graph message as (not) spam used to call IMAP directly,
// bypassing every transport dispatch the other actions have — so on a native account
// it looked available and failed. It now goes through the same journal-backed move,
// and the training record and verdict are written only when the provider confirmed it.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  runProviderMutation: vi.fn(),
  graphFolderIdForPath: vi.fn(),
  resolveSpamFolder: vi.fn(),
  adjustFolderCounts: vi.fn(),
  broadcast: vi.fn(),
  moveMessage: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    moveMessage: mocks.moveMessage,
    broadcast: mocks.broadcast,
    _guardMoveUid: mocks._guardMoveUid,
    _unguardMoveUid: mocks._unguardMoveUid,
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
  return { ...actual, resolveSpamFolder: mocks.resolveSpamFolder, adjustFolderCounts: mocks.adjustFolderCounts };
});

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
  // The training write commits through withTransaction; drive it with the same query
  // mock so the INSERT is observable.
  mocks.withTransaction.mockImplementation((async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: (text: string, params?: unknown[]) => mocks.query(text, params) })) as never);
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.resolveSpamFolder.mockResolvedValue('Spam');
  mocks.graphFolderIdForPath.mockResolvedValue('graph-junk');
  mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', value: { id: 'AAMkAD-2' }, replayed: false });
});

function arrangeSpam() {
  mocks.query
    .mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, folder_mappings: null }], rowCount: 1 })   // route lookup
    .mockResolvedValueOnce({
      rows: [{
        id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', is_read: false,
        provider_message_id: 'AAMkAD-1', message_id: null, subject: 'Buy now', folder_mappings: null,
      }],
      rowCount: 1,
    })                                                                                                   // moveForSpamLabel lookup
    .mockResolvedValueOnce({
      rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }],
      rowCount: 1,
    });                                                                                                  // account
}

const markSpam = () => fetch(`${base}/api/mail/messages/${MESSAGE_ID}/spam`, { method: 'POST' });

describe('spam marking on a Microsoft Graph account', () => {
  it('moves to Junk through the provider and records the verdict', async () => {
    arrangeSpam();

    const response = await markSpam();
    expect(response.status).toBe(200);

    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'AAMkAD-1', destinationFolderId: 'graph-junk' });
    expect(adapter).toMatchObject({ idempotent: false });
    // The verdict is recorded with the identity the move produced.
    const verdict = mocks.query.mock.calls.find(([sql]) => String(sql).includes('spam_user_override'));
    expect(verdict).toBeDefined();
    expect(verdict?.[1]).toContain('spam');
    // The IMAP move is never involved for a native account.
    expect(mocks.moveMessage).not.toHaveBeenCalled();
    expect(mocks.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'Spam', accountId: ACCOUNT_ID }, 'user-1');
  });

  it('records nothing when the provider refuses the move', async () => {
    arrangeSpam();
    mocks.runProviderMutation.mockResolvedValue({ status: 'permanent', operationId: 'op-1', code: 'RESOURCE_NOT_FOUND', replayed: false });

    const response = await markSpam();
    expect(response.status).toBe(502);
    // A training row for a move that did not happen would be a lie, so no verdict and
    // no training record is written.
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('spam_user_override'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('spam_training_log'))).toBe(false);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
