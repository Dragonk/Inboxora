// `/mail/sync-folders` is the trigger that creates the first Microsoft Graph
// mail-folder collection — the scheduled refresh only visits collections that
// already exist, so without this branch the adapter would be unreachable. The
// transport decides which path runs, and the IMAP path must be untouched.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  syncFoldersNow: vi.fn(),
  broadcast: vi.fn(),
  syncGraphMailFoldersForAccount: vi.fn(),
  providerIntegrationsEnabled: vi.fn(() => true),
  isMicrosoftConfigured: vi.fn(() => true),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    setFlag: vi.fn(),
    broadcast: mocks.broadcast,
    syncFoldersNow: mocks.syncFoldersNow,
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providerSwitches.js', () => ({ providerIntegrationsEnabled: mocks.providerIntegrationsEnabled }));
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  isMicrosoftConfigured: mocks.isMicrosoftConfigured,
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));
vi.mock('../services/providers/microsoft/graphMailSync.js', () => ({ syncGraphMailFoldersForAccount: mocks.syncGraphMailFoldersForAccount }));

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
  mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.syncFoldersNow.mockReset().mockResolvedValue(undefined);
  mocks.broadcast.mockReset();
  mocks.syncGraphMailFoldersForAccount.mockReset().mockResolvedValue({ accountId: ACCOUNT_ID });
  mocks.providerIntegrationsEnabled.mockReset().mockReturnValue(true);
  mocks.isMicrosoftConfigured.mockReset().mockReturnValue(true);
});

function syncFolders(body: Record<string, unknown>) {
  return fetch(`${base}/api/mail/sync-folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** The route dispatches in the background; give the promise chain a turn. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('folder discovery is dispatched by the account transport', () => {
  it('uses the provider adapter for a Microsoft Graph account', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: CONNECTION_ID }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'microsoft_graph' });
    await flush();

    expect(mocks.syncGraphMailFoldersForAccount).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', accountId: ACCOUNT_ID, connectionId: CONNECTION_ID,
      config: expect.objectContaining({ clientId: 'client-1' }),
    }));
    expect(mocks.syncFoldersNow).not.toHaveBeenCalled();
    // The client is told to refetch, exactly as the IMAP path does.
    expect(mocks.broadcast).toHaveBeenCalledWith({ type: 'folders_synced', accountId: ACCOUNT_ID }, 'user-1');
  });

  it('leaves an IMAP account on the IMAP path', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'imap_smtp', provider_connection_id: null }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
    expect(mocks.syncFoldersNow).toHaveBeenCalledWith('user-1', ACCOUNT_ID);
  });

  it('treats an account with no transport recorded as IMAP, which is what a pre-v4 row is', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: null, provider_connection_id: null }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(200);
    expect(mocks.syncFoldersNow).toHaveBeenCalledWith('user-1', ACCOUNT_ID);
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
  });

  it('refuses a Graph account when the installation switched the provider layer off', async () => {
    mocks.providerIntegrationsEnabled.mockReturnValue(false);
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: CONNECTION_ID }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(403);
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
    expect(mocks.syncFoldersNow).not.toHaveBeenCalled();
  });

  it('refuses a Graph account when the administrator has not configured Microsoft', async () => {
    mocks.isMicrosoftConfigured.mockReturnValue(false);
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: CONNECTION_ID }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(409);
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
  });

  it('refuses a Graph account that is not linked to a connection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: null }], rowCount: 1 });

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(409);
    expect(mocks.syncGraphMailFoldersForAccount).not.toHaveBeenCalled();
  });

  it('does not lose the response when the provider sync fails', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: CONNECTION_ID }], rowCount: 1 });
    mocks.syncGraphMailFoldersForAccount.mockRejectedValueOnce(new Error('grant revoked'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await syncFolders({ accountId: ACCOUNT_ID });
    expect(response.status).toBe(200);
    await flush();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Graph folder discovery error'), 'grant revoked');
    expect(mocks.broadcast).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
