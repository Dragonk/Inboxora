// Snooze on a Microsoft Graph account: the folder it needs must be created on the
// provider *and* discovered, the move goes through the shared helper, and the IMAP
// `ensureFolder` is never called. Without the first two the action would look
// available and fail, which is what it did before this wiring.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  moveGraphMessageToFolder: vi.fn(),
  graphFolderIdForPath: vi.fn(),
  graphCreateMailFolder: vi.fn(),
  syncGraphMailFoldersForAccount: vi.fn(),
  adjustFolderCounts: vi.fn(),
  ensureFolder: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    ensureFolder: mocks.ensureFolder,
    moveMessage: vi.fn(),
    broadcast: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    setFlag: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providers/microsoft/graphMailMove.js', () => ({ moveGraphMessageToFolder: mocks.moveGraphMessageToFolder }));
vi.mock('../services/providers/microsoft/graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailSync.js')>();
  return {
    ...actual,
    graphFolderIdForPath: mocks.graphFolderIdForPath,
    syncGraphMailFoldersForAccount: mocks.syncGraphMailFoldersForAccount,
  };
});
vi.mock('../services/providers/microsoft/graphMailMutations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailMutations.js')>();
  return { ...actual, graphCreateMailFolder: mocks.graphCreateMailFolder };
});
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mailUtils.js')>();
  return { ...actual, adjustFolderCounts: mocks.adjustFolderCounts };
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
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.graphFolderIdForPath.mockResolvedValue('graph-snoozed');
  mocks.moveGraphMessageToFolder.mockResolvedValue({ moved: true, newProviderMessageId: 'AAMkAD-2', newUid: '77' });
});

function arrangeSnooze() {
  mocks.query
    .mockResolvedValueOnce({
      rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', message_id: '<m1@x>', is_read: false, provider_message_id: 'AAMkAD-1' }],
      rowCount: 1,
    })                                                                                  // message lookup
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                   // not already snoozed
    .mockResolvedValueOnce({
      rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }],
      rowCount: 1,
    })                                                                                  // account
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                   // conversation pool
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });                                  // already-snoozed headers
}

const snooze = (body: Record<string, unknown>) =>
  fetch(`${base}/api/mail/messages/${MESSAGE_ID}/snooze`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

describe('snooze on a Microsoft Graph account', () => {
  it('moves through the provider when the folder is already discovered', async () => {
    arrangeSnooze();

    const response = await snooze({ until: new Date(Date.now() + 3600_000).toISOString() });
    expect(response.status).toBe(200);

    expect(mocks.moveGraphMessageToFolder).toHaveBeenCalledWith(expect.objectContaining({
      accountId: ACCOUNT_ID, connectionId: 'connection-1', resourceId: MESSAGE_ID, destinationPath: 'Snoozed',
    }));
    // The provider path is used; the IMAP folder creation is not.
    expect(mocks.ensureFolder).not.toHaveBeenCalled();
    expect(mocks.graphCreateMailFolder).not.toHaveBeenCalled();
    // The snooze record is written with the original folder.
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO snoozed_messages'));
    expect(insert?.[1]).toEqual(expect.arrayContaining([ 'user-1', ACCOUNT_ID, '<m1@x>', 'INBOX', 'Snoozed' ]));
  });

  it('creates and discovers the folder when the provider does not have it yet', async () => {
    arrangeSnooze();
    // Not discovered on the first look, present after the create + discovery.
    mocks.graphFolderIdForPath.mockResolvedValueOnce(null).mockResolvedValue('graph-snoozed');

    const response = await snooze({ until: new Date(Date.now() + 3600_000).toISOString() });
    expect(response.status).toBe(200);
    expect(mocks.graphCreateMailFolder).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }), 'Snoozed');
    expect(mocks.syncGraphMailFoldersForAccount).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT_ID }));
    expect(mocks.moveGraphMessageToFolder).toHaveBeenCalled();
  });

  it('refuses rather than half-snoozing when the folder cannot be prepared', async () => {
    arrangeSnooze();
    mocks.graphFolderIdForPath.mockResolvedValue(null);

    const response = await snooze({ until: new Date(Date.now() + 3600_000).toISOString() });
    expect(response.status).toBe(502);
    expect(mocks.moveGraphMessageToFolder).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO snoozed_messages'))).toBe(false);
  });
});
