import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), safeFetch: vi.fn(), noteUserActivity: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { session?: unknown }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../index.js', () => ({ imapManager: { noteUserActivity: mocks.noteUserActivity, broadcast: vi.fn(), pluginFacade: {} } }));
import mailRoutes from './mail.js';

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let server: Server; let base = '';
beforeAll(async () => { const app = express(); app.use(express.json()); app.use('/api/mail', mailRoutes); await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); }); base = `http://127.0.0.1:${listeningPort(server)}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { vi.clearAllMocks(); });
const oneClick = { list_unsubscribe: '<https://public.example/unsub?token=secret>', list_unsubscribe_post: 'List-Unsubscribe=One-Click', unsubscribed_at: null };
async function post() { return fetch(`${base}/api/mail/messages/${ID}/unsubscribe`, { method: 'POST' }); }

describe('unsubscribe result truthfulness', () => {
  it('offers a URL without marking the message unsubscribed', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...oneClick, list_unsubscribe_post: null }], rowCount: 1 });
    const response = await post();
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'offered', type: 'url' });
    expect(mocks.query).toHaveBeenCalledTimes(1); expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
  it('confirms only a direct 2xx one-click POST', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [oneClick], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ state: 'pending' }], rowCount: 1 }).mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.safeFetch.mockResolvedValue({ ok: true, status: 204 });
    const response = await post();
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'confirmed' });
    expect(mocks.safeFetch).toHaveBeenCalledWith(expect.stringContaining('token=secret'), expect.objectContaining({ method: 'POST', redirect: 'manual' }));
    expect(String(mocks.query.mock.calls[2][0])).toContain('unsubscribed_at = NOW()');
  });
  it('treats a redirect as uncertain and does not timestamp success', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [oneClick], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ state: 'pending' }], rowCount: 1 }).mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.safeFetch.mockResolvedValue({ ok: false, status: 302 });
    const response = await post();
    expect(response.status).toBe(502); expect((await response.json() as { code?: string }).code).toBe('UNSUBSCRIBE_OUTCOME_UNKNOWN');
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes('unsubscribed_at = NOW()'))).toBe(false);
  });
});
