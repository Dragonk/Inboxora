import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import 'express-async-errors';
import { listeningPort } from '../test/net.js';
import { mockSession } from '../test/http.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), preview: vi.fn(), seen: vi.fn(), edit: vi.fn(), page: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/sendMail.js', () => ({ executeSend: vi.fn(() => { throw new Error('Transport is forbidden in route tests'); }) }));
vi.mock('../services/scheduledMailPreview.js', () => ({ previewScheduledMail: mocks.preview }));
vi.mock('../services/scheduledMail.js', () => ({
  ScheduledMailError: class extends Error {},
  acknowledgeSentMail: mocks.seen, editScheduledMail: mocks.edit, pageScheduledMail: mocks.page,
  listScheduledMail: vi.fn(), enqueueScheduledMail: vi.fn(), enqueueMailMerge: vi.fn(),
  cancelScheduledMail: vi.fn(), dismissScheduledMail: vi.fn(), rescheduleMail: vi.fn(), updateScheduledMail: vi.fn(),
}));
import router from './scheduledMail.js';

describe('scheduled preview and visibility HTTP authorization', () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header('x-test-session');
      req.session = mockSession({ ...(userId ? { userId } : {}), destroy: vi.fn() }); next();
    });
    app.use('/api/mail', router);
    await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); });
    base = `http://127.0.0.1:${listeningPort(server)}/api/mail/scheduled`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ id: 'session-owner' }] });
    mocks.preview.mockResolvedValue({ id: 'queued', state: 'pending', message: { body: 'Owned preview' } });
    mocks.seen.mockResolvedValue({ id: 'queued' });
    mocks.page.mockResolvedValue({ items: [], nextCursor: null });
  });
  it.each([['GET', '/queued'], ['POST', '/queued/seen'], ['GET', '?page=1']])('rejects unauthenticated %s %s before reading or acknowledging anything', async (method, path) => {
    const response = await fetch(base + path, { method });
    expect(response.status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.seen).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.page).not.toHaveBeenCalled();
  });
  it('rejects a revoked session at the real authentication middleware', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await fetch(base + '/queued/seen', { method: 'POST', headers: { 'x-test-session': 'revoked-owner' } });
    expect(response.status).toBe(401); expect(mocks.seen).not.toHaveBeenCalled();
  });
  it('uses only the session owner for preview and never pauses or acknowledges during a GET', async () => {
    const response = await fetch(base + '/queued?userId=foreign-owner', { headers: { 'x-test-session': 'session-owner' } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: 'pending' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith('session-owner', 'queued');
    expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.seen).not.toHaveBeenCalled();
  });
  it('ignores a forged owner or revision in a visibility acknowledgement', async () => {
    const response = await fetch(base + '/queued/seen', { method: 'POST',
      headers: { 'x-test-session': 'session-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'foreign-owner', revision: 999, state: 'sent' }) });
    expect(response.status).toBe(200);
    expect(mocks.seen).toHaveBeenCalledExactlyOnceWith('session-owner', 'queued');
    expect(mocks.edit).not.toHaveBeenCalled();
  });
  it('passes an opaque page cursor without marking the returned list seen', async () => {
    const response = await fetch(base + '?page=1&cursor=cursor-value', { headers: { 'x-test-session': 'session-owner' } });
    expect(response.status).toBe(200);
    expect(mocks.page).toHaveBeenCalledExactlyOnceWith('session-owner', 'cursor-value');
    expect(mocks.seen).not.toHaveBeenCalled(); expect(mocks.edit).not.toHaveBeenCalled();
  });
});
