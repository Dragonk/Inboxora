// Folder management is IMAP-only. On a native account these four routes used to
// attempt an IMAP session and fail with a generic error, so an unsupported
// operation looked like a broken one. They now refuse explicitly and name the
// workaround the user has.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  graphCreateMailFolder: vi.fn(),
  graphRenameMailFolder: vi.fn(),
  graphFolderIdForPath: vi.fn(),
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

vi.mock('../services/providers/microsoft/graphMailSync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailSync.js')>();
  return { ...actual, graphFolderIdForPath: mocks.graphFolderIdForPath, syncGraphMailFoldersForAccount: mocks.syncGraphMailFoldersForAccount };
});
vi.mock('../services/providers/microsoft/graphMailMutations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailMutations.js')>();
  return { ...actual, graphCreateMailFolder: mocks.graphCreateMailFolder, graphRenameMailFolder: mocks.graphRenameMailFolder };
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
  // Create and rename are implemented for a native account now; delete and empty
  // still refuse, and the test says which is which rather than assuming all four.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['/folders/delete', { accountId: ACCOUNT_ID, path: 'A' }],
    ['/folders/empty', { accountId: ACCOUNT_ID, path: 'A' }],
  ];

  for (const [path, body] of cases) {
    it(`${path} answers 501 with a code and names the workaround`, async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }],
        rowCount: 1,
      });

      const response = await post(path, body);
      expect(response.status).toBe(501);
      const payload = await response.json() as { code: string; error: string };
      expect(payload.code).toBe('OPERATION_FORBIDDEN');
      expect(payload.error).toContain('Sync folders');
      // No IMAP call is attempted for an account that has no IMAP session.
      expect(mocks.createFolder).not.toHaveBeenCalled();
      expect(mocks.renameFolder).not.toHaveBeenCalled();
      expect(mocks.deleteFolder).not.toHaveBeenCalled();
      expect(mocks.emptyFolder).not.toHaveBeenCalled();
    });
  }

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
