// Folder management is IMAP-only. On a native account these four routes used to
// attempt an IMAP session and fail with a generic error, so an unsupported
// operation looked like a broken one. They now refuse explicitly and name the
// workaround the user has.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
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
});

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/mail${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('folder management on a native account refuses instead of failing like a bug', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['/folders', { accountId: ACCOUNT_ID, name: 'Projects' }],
    ['/folders/rename', { accountId: ACCOUNT_ID, oldPath: 'A', newName: 'B' }],
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
