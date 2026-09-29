import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), push: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../services/providerMailFlagWrite.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../services/providerMailFlagWrite.js')>(), pushProviderMessageFlag: mocks.push }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: {
        session?: {
            userId: string;
        };
    }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { setFlag: vi.fn(), broadcast: vi.fn(), pluginFacade: {} } }));
import express from 'express';
import 'express-async-errors';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let server: Server;
let base: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).json({ error: 'Unavailable' }); });
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
    mocks.query.mockReset();
    mocks.push.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.query.mockResolvedValueOnce({ rows: [{ id, account_id: accountId, uid: 42, folder: 'INBOX', message_id: null, is_read: true }] }).mockResolvedValueOnce({ rows: [{ id: accountId, mail_transport: 'gmail_api' }] });
});
const patch = (field: 'read' | 'star', value: unknown) => fetch(`${base}/api/mail/messages/${id}/${field}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field === 'read' ? 'read' : 'starred']: value }) });
describe('mail flag response contract', () => {
    it.each(['read', 'star'] as const)('confirms %s only after durable writer confirmation', async (field) => {
        mocks.push.mockResolvedValue({ status: 'confirmed' });
        const response = await patch(field, true);
        expect(await response.json()).toEqual({ ok: true, updated: [id], pending: [], failed: [], outcomes: [{ id, status: 'confirmed' }], [field === 'read' ? 'is_read' : 'is_starred']: true });
        expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ messageId: id, flag: field === 'read' ? '\\Seen' : '\\Flagged', value: true }));
    });
    it.each(['retryable', 'pending', 'outcome_unknown'])('reports %s without optimistic success', async (status) => {
        mocks.push.mockResolvedValue({ status, code: 'TEST_PENDING' });
        expect(await (await patch('read', true)).json()).toEqual({ ok: true, updated: [], pending: [id], failed: [], outcomes: [{ id, status, code: 'TEST_PENDING' }] });
        expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE messages'))).toBe(false);
    });
    it('reports permanent refusal and never rolls back a newer local intent', async () => {
        mocks.push.mockResolvedValue({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
        expect(await (await patch('read', false)).json()).toMatchObject({ updated: [], failed: [id], pending: [] });
        expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE messages'))).toBe(false);
    });
    it('reasserts a same-state click', async () => {
        mocks.push.mockResolvedValue({ status: 'confirmed' });
        await patch('read', true);
        expect(mocks.push).toHaveBeenCalledTimes(1);
    });
    it('does not dispatch when durable storage fails', async () => {
        mocks.push.mockRejectedValue(new Error('storage unavailable'));
        expect((await patch('read', true)).status).toBe(503);
    });
    it('rejects invalid flag values', async () => { expect((await patch('read', 'true')).status).toBe(400); expect(mocks.push).not.toHaveBeenCalled(); });
});
