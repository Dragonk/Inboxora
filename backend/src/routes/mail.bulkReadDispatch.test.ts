import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), push: vi.fn(), batch: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../services/providerMailFlagWrite.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../services/providerMailFlagWrite.js')>(), pushProviderMessageFlag: mocks.push, pushProviderMessageFlags: mocks.batch }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: {
        session?: {
            userId: string;
        };
    }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { setFlag: vi.fn(), broadcast: vi.fn(), pluginFacade: {} } }));
import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';
const ids = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let server: Server;
let base: string;
beforeAll(async () => { const app = express(); app.use(express.json()); app.use('/api/mail', mailRoutes); await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); }); base = `http://127.0.0.1:${listeningPort(server)}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { mocks.query.mockReset(); mocks.push.mockReset(); mocks.batch.mockReset(); mocks.batch.mockImplementation(async (inputs: Array<{ messageId: string }>) => Promise.all(inputs.map(async input => ({ id: input.messageId, ...await mocks.push(input) })))); mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT m.*') ? ids.map(id => ({ id, account_id: accountId, uid: 42, folder: 'INBOX', is_read: true })) : sql.includes('SELECT * FROM email_accounts') ? [{ id: accountId }] : [] })); });
const post = (path: string, body: unknown) => fetch(`${base}/api/mail${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('bulk flag outcomes', () => {
    it.each([['bulk-read', 'read'], ['bulk-star', 'starred']])('reports mixed %s results without blanket success', async (path, field) => {
        mocks.push.mockResolvedValueOnce({ status: 'confirmed' }).mockResolvedValueOnce({ status: 'retryable', code: 'UPSTREAM_UNAVAILABLE' }).mockResolvedValueOnce({ status: 'permanent', code: 'PROVIDER_AUTH_REQUIRED' });
        const result = await (await post(`/messages/${path}`, { ids, [field]: true })).json();
        expect(result).toMatchObject({ ok: true, updated: [ids[0]], pending: [ids[1]], failed: [ids[2]] });
        expect(result).toMatchObject({ outcomes: [{ id: ids[0], status: 'confirmed' }, { id: ids[1], status: 'retryable' }, { id: ids[2], status: 'permanent' }] });
        expect(mocks.push).toHaveBeenCalledTimes(3);
    });
    it.each(['gmail_api', 'microsoft_graph', 'imap_smtp'])('dispatches every same-state %s action through durable service', async (transport) => {
        mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT m.*') ? [{ id: ids[0], account_id: accountId, uid: 42, folder: 'INBOX', is_read: true }] : sql.includes('SELECT * FROM email_accounts') ? [{ id: accountId, mail_transport: transport }] : [] }));
        mocks.push.mockResolvedValue({ status: 'confirmed' });
        await post('/messages/bulk-read', { ids: [ids[0]], read: true });
        expect(mocks.batch).toHaveBeenCalledWith([{ userId: 'user-1', accountId, messageId: ids[0], flag: '\\Seen', value: true }], expect.objectContaining({ manager: expect.any(Object) }));
    });
    it('includes unowned IDs only as failures without writing them', async () => {
        mocks.query.mockResolvedValue({ rows: [] });
        expect(await (await post('/messages/bulk-read', { ids, read: true })).json()).toMatchObject({ updated: [], pending: [], failed: ids });
        expect(mocks.push).not.toHaveBeenCalled();
    });
});
