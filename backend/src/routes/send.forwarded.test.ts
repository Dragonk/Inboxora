import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), del: vi.fn() },
}));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: vi.fn(), appendToSent: vi.fn(), syncFolderOnDemand: vi.fn(), upsertSentMessageRecord: vi.fn() } }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
// A forwarded message whose *sending* account is native still reads its bytes from the source account, and the
// sending account's transport is bound by the seam — so that half is faked here rather than dialled.
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
vi.mock('../services/providers/microsoft/graphMailSend.js', () => ({ createGraphDraft: vi.fn(async () => ({ id: 'draft-1' })), sendGraphDraft: vi.fn(async () => ({ status: 'accepted' })) }));
vi.mock('../services/providers/microsoft/graphMailAttachments.js', () => ({ addGraphAttachment: vi.fn(async () => ({ id: 'att-1', strategy: 'direct' })) }));

import express from 'express';
import sendRoutes from './send.js';
import { query as __mock_query } from '../services/db.js';
import { imapManager as __mock_imapManager } from '../index.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

// Expose mocked module exports with their Vitest mock helpers.
const query = vi.mocked(__mock_query);
const imapManager = vi.mocked(__mock_imapManager);

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const ACCOUNT = { id: ACCOUNT_ID, email_address: 'me@example.com', name: 'Me', sender_name: null, signature: null };

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', sendRoutes);
  return app;
}

describe('POST /api/mail/send — forwarded attachment guards (#F2)', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchAttachment.mockReset(); });

  const post = (body: unknown) => fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const hasError = (body: unknown): body is { error: string } => (
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
  );

  it('rejects more than 100 forwarded attachments before doing any DB work', async () => {
    const forwardedAttachments = Array.from({ length: 101 }, () => ({ messageId: MSG_ID, part: '2' }));
    const res = await post({ accountId: ACCOUNT_ID, to: ['x@example.com'], forwardedAttachments });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(hasError(body)).toBe(true);
    if (hasError(body)) {
      expect(body.error).toMatch(/Too many forwarded attachments/);
    }
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('rejects an oversized forwarded batch by declared size, before fetching any attachment', async () => {
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('SELECT preferences FROM users')) return Promise.resolve({ rows: [{ preferences: {} }] });
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) {
        return Promise.resolve({ rows: [{
          id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
          attachments: [{ part: '2', size: 30_000_000, filename: 'big.pdf', type: 'application/pdf' }],
        }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'],
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(hasError(body)).toBe(true);
    if (hasError(body)) {
      // §22.1: this guard totals uploads and forwarded attachments, so the dimension is the attachment total
      // rather than the composed message — the two are refused for different reasons and carry different codes.
      const refused = body as unknown as { code?: string; dimension?: string; actualBytes?: number; limitBytes?: number };
      expect(refused.code).toBe('ATTACHMENTS_TOO_LARGE');
      expect(refused.dimension).toBe('attachments');
      expect(refused.actualBytes).toBeGreaterThan(refused.limitBytes ?? 0);
    }
    // The whole point: no IMAP fetch happens when the declared size already blows the limit.
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('accounts a forwarded attachment against the sending transport, while reading it from its own', async () => {
    // The same 30 MB declared attachment that SMTP refuses: the sending account is native Microsoft Graph, whose
    // ceiling carries it, so the declared guard must not refuse it — and the bytes are still read from the source
    // account over the source account's transport (IMAP here, faked), never over the sending account's.
    const graphAccount = { ...ACCOUNT, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' };
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [graphAccount] });
      if (sql.includes('SELECT preferences FROM users')) return Promise.resolve({ rows: [{ preferences: {} }] });
      if (sql.includes('FROM email_accounts WHERE id = ANY')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) {
        return Promise.resolve({ rows: [{
          id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
          attachments: [{ part: '2', size: 30_000_000, filename: 'big.pdf', type: 'application/pdf' }],
        }] });
      }
      if (sql.includes('INSERT INTO send_idempotency')) return Promise.resolve({ rows: [{ status: 'pending' }] });
      return Promise.resolve({ rows: [] });
    });
    const { imapManager: mocked } = await import('../index.js');
    vi.mocked(mocked.fetchAttachment).mockResolvedValue(Buffer.alloc(1024, 1));

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'],
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });
    expect(res.status).toBe(200);
    // The source account's transport served the read; the sending account's transport did the send.
    expect(vi.mocked(mocked.fetchAttachment)).toHaveBeenCalledOnce();
    const { sendGraphDraft } = await import('../services/providers/microsoft/graphMailSend.js');
    expect(vi.mocked(sendGraphDraft)).toHaveBeenCalledOnce();
  });
});
