// Bulk read/unread must reach the **account's own transport**. The route used to call
// `imapManager.setFlag` for every account it grouped, so a native Graph or Gmail
// account had an IMAP connection opened for a mailbox that has no IMAP session — and
// the response still said the change was applied. This is the regression that pins the
// dispatch, on all three transports.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  runProviderMutation: vi.fn(),
  setFlag: vi.fn(async () => undefined),
  enqueueFlagPush: vi.fn(),
  resolveFlagPush: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    setFlag: mocks.setFlag,
    _enqueueFlagPush: mocks.enqueueFlagPush,
    _resolveFlagPush: mocks.resolveFlagPush,
    broadcast: mocks.broadcast,
    pluginFacade: {},
  },
}));
vi.mock('../services/providerMutationService.js', () => ({ runProviderMutation: mocks.runProviderMutation }));
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
  googleConfigFromEnv: () => ({ clientId: 'client-google', clientSecret: 'secret-google', redirectUri: 'https://x/google/cb' }),
}));

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const MESSAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
  mocks.setFlag.mockResolvedValue(undefined);
  mocks.runProviderMutation.mockResolvedValue({ status: 'confirmed', operationId: 'op-1', replayed: false });
});

function arrangeUnreadMessage(account: Record<string, unknown>): void {
  mocks.query
    .mockResolvedValueOnce({
      rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 42, folder: 'INBOX', is_read: false, provider_message_id: 'm1' }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // the local read-state update
    // `adjustFolderCounts` runs its own (fire-and-forget) statement before the
    // per-account grouping, so the account read is the fourth query.
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [account], rowCount: 1 }); // the account row
}

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/mail${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('bulk read/unread dispatches on the account transport', () => {
  it('writes a Gmail account\'s flag through the journal, never over IMAP', async () => {
    arrangeUnreadMessage({ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'gmail_api', provider_connection_id: 'connection-g' });

    const response = await post('/messages/bulk-read', { ids: [MESSAGE_ID], read: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, updated: [MESSAGE_ID] });

    expect(mocks.setFlag).not.toHaveBeenCalled();
    expect(mocks.runProviderMutation).toHaveBeenCalledTimes(1);
    const [request, adapter] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'm1', flag: '\\Seen', value: true });
    expect(String(request.idempotencyKey)).toMatch(/^gmail-mail-flag:/);
    expect(adapter).toMatchObject({ resourceType: 'message', idempotent: true });
  });

  it('writes a Microsoft Graph account\'s flag through the journal, never over IMAP', async () => {
    arrangeUnreadMessage({ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' });

    // The row is unread, so `read: true` is the change that must reach the provider:
    // asking for the state a message is already in is correctly a no-op.
    const response = await post('/messages/bulk-read', { ids: [MESSAGE_ID], read: true });
    expect(response.status).toBe(200);

    expect(mocks.setFlag).not.toHaveBeenCalled();
    const [request] = mocks.runProviderMutation.mock.calls[0];
    expect(request.payload).toMatchObject({ providerMessageId: 'm1', flag: '\\Seen', value: true });
    expect(String(request.idempotencyKey)).toMatch(/^graph-mail-flag:/);
  });

  it('keeps an IMAP account on the IMAP flag write', async () => {
    arrangeUnreadMessage({ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'imap_smtp', provider_connection_id: null });

    const response = await post('/messages/bulk-read', { ids: [MESSAGE_ID], read: true });
    expect(response.status).toBe(200);

    expect(mocks.setFlag).toHaveBeenCalledTimes(1);
    expect(mocks.runProviderMutation).not.toHaveBeenCalled();
    expect(mocks.resolveFlagPush).toHaveBeenCalledWith(ACCOUNT_ID, MESSAGE_ID, '\\Seen');
  });
});
