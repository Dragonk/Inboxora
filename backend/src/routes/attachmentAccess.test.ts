import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
const mocks = vi.hoisted(() => ({ query: vi.fn(), fetchAttachment: vi.fn(), scan: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: mocks.fetchAttachment } }));
vi.mock('../services/attachments/scan.js', async importOriginal => {
  const original = await importOriginal<typeof import('../services/attachments/scan.js')>();
  return { ...original, approveAttachmentPreview: mocks.scan };
});
import mail from './mail.js';
import scheduled from './scheduledMail.js';
const messageId = '11111111-1111-4111-8111-111111111111';
const scheduledId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const payload = Buffer.from('Private attachment fixture');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scan.mockResolvedValue(true); mocks.fetchAttachment.mockResolvedValue(payload);
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('SELECT id FROM users')) return { rows: ['owner', 'other'].includes(String(values[0])) ? [{ id: values[0] }] : [] };
    if (sql.includes('FROM messages m') && sql.includes('a.user_id = $2')) return { rows: values[0] === messageId && values[1] === 'owner' ? [{ id: messageId, account_id: accountId, uid: 1, folder: 'INBOX', attachments: [{ part: '1', filename: 'private.txt', type: 'text/plain', size: payload.length }] }] : [] };
    if (sql.includes('FROM email_accounts WHERE id = $1')) return { rows: [{ id: accountId, user_id: 'owner', mail_transport: 'smtp' }] };
    if (sql.includes('FROM scheduled_mail WHERE id=$1 AND user_id=$2')) return { rows: values[0] === scheduledId && values[1] === 'owner' ? [{ state: 'scheduled', revision: 2, payload: { payload: { attachments: [{ filename: 'private.txt', content: payload.toString('base64') }] } } }] : [] };
    return { rows: [] };
  });
});
async function serverFor(run: (origin: string) => Promise<void>) {
  const app = express(); app.use(session({ secret: 'public-attachment-access-test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { const user = req.get('X-Test-Identity'); if (user) req.session.userId = user; next(); });
  app.use('/api/mail', mail, scheduled);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
describe('attachment links never grant access by themselves', () => {
  it('refuses anonymous, other-user and deleted-user sessions before bytes or scans', async () => serverFor(async origin => {
    for (const path of [`messages/${messageId}/attachments/1`, `messages/${messageId}/attachments.zip`, `scheduled/${scheduledId}/attachments/0?revision=2`]) {
      for (const identity of ['', 'other', 'deleted']) {
        const response = await fetch(`${origin}/api/mail/${path}`, { headers: identity ? { 'X-Test-Identity': identity } : {} });
        expect(response.status, path + identity).toBe(identity === 'other' ? 404 : 401);
        expect(await response.text()).not.toContain(payload.toString());
      }
    }
    expect(mocks.fetchAttachment).not.toHaveBeenCalled(); expect(mocks.scan).not.toHaveBeenCalled();
  }));
  it('authorizes the displayed physical copy and exact queue revision', async () => serverFor(async origin => {
    const headers = { 'X-Test-Identity': 'owner', 'X-Requested-With': 'MailFlow' };
    const physical = await fetch(`${origin}/api/mail/messages/${messageId}/attachments/1?preview=1`, { headers });
    expect(physical.status).toBe(200); expect(Buffer.from(await physical.arrayBuffer())).toEqual(payload);
    expect(physical.headers.get('content-disposition')).toContain('attachment;');
    const stale = await fetch(`${origin}/api/mail/scheduled/${scheduledId}/attachments/0?revision=1&preview=1`, { headers });
    expect(stale.status).toBe(409);
    const queued = await fetch(`${origin}/api/mail/scheduled/${scheduledId}/attachments/0?revision=2&preview=1`, { headers });
    expect(queued.status).toBe(200); expect(Buffer.from(await queued.arrayBuffer())).toEqual(payload);
    expect(queued.headers.get('cache-control')).toContain('no-store');
    expect(queued.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.scan).toHaveBeenCalledTimes(2);
  }));
});
