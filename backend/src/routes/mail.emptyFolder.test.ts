import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonBody } from '../test/json.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { emptyFolder: vi.fn(), broadcast: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query as __mock_query } from '../services/db.js';
import { imapManager as __mock_imapManager } from '../index.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

// Cast mocked module exports so their vitest mock helpers type-check.
const query = vi.mocked(__mock_query);
const imapManager = vi.mocked(__mock_imapManager);

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const clearedDb = () => query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages WHERE account_id = $1 AND folder = $2'));
interface EmittedPayload { type?: string; ok?: boolean }

const emittedType = (type: string): EmittedPayload | undefined => imapManager.broadcast.mock.calls
  .map((call) => call[0] as EmittedPayload)
  .find((payload) => payload?.type === type);

describe('POST /api/mail/folders/empty — async background empty', () => {
  let server: Server, base: string;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${listeningPort(server)}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset(); imapManager.emptyFolder.mockReset(); imapManager.broadcast.mockReset();
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      return Promise.resolve({ rows: [] });
    });
  });

  const empty = (path: string) => fetch(`${base}/api/mail/folders/empty`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, path }),
  });

  it('returns 202 immediately and finishes the delete in the background', async () => {
    imapManager.emptyFolder.mockResolvedValue(undefined);
    const res = await empty('Trash');
    expect(res.status).toBe(202);
    expect(((await res.json()) as JsonBody).started).toBe(true);
    await tick();
    expect(imapManager.emptyFolder).toHaveBeenCalledWith(ACCOUNT, 'Trash');
    expect(clearedDb()).toBe(true);
    expect(emittedType('folder_emptied')?.ok).toBe(true);
    expect(emittedType('sync_complete')).toBeTruthy();
  });

  it('leaves the DB rows intact and reports failure when the IMAP empty throws', async () => {
    imapManager.emptyFolder.mockRejectedValue(new Error('throttled'));
    const res = await empty('Archive');
    expect(res.status).toBe(202);
    await tick();
    expect(clearedDb()).toBe(false);            // next sync reconciles instead
    expect(emittedType('folder_emptied')?.ok).toBe(false);
    expect(emittedType('sync_complete')).toBeUndefined();
  });

  it('rejects a concurrent empty of the same folder with 409', async () => {
    let release: ((value?: unknown) => void) | undefined;
    imapManager.emptyFolder.mockImplementation(() => new Promise(r => { release = r; }));
    const first = await empty('Junk');
    expect(first.status).toBe(202);
    const second = await empty('Junk');   // same folder still in flight
    expect(second.status).toBe(409);
    release();                            // let the first complete so the guard clears
    await tick();
  });
});
