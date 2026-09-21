import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { JsonBody } from '../test/json.js';

// A native Microsoft account answers the same POST /send, and the route must reach Graph for it: no SMTP
// socket, no IMAP APPEND, and the three transport outcomes mapped onto the intent's lifecycle.
const draftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-draft-1' })));
const replyDraftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-reply-1' })));
const patchDraftMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' as const })));
const attachMock = vi.hoisted(() => vi.fn(async () => ({ id: 'att-1', strategy: 'direct' as const })));
vi.mock('../services/providers/microsoft/graphMailSend.js', () => ({
  createGraphDraft: draftMock,
  createGraphReplyDraft: replyDraftMock,
  patchGraphDraft: patchDraftMock,
  sendGraphDraft: sendMock,
}));
vi.mock('../services/providers/microsoft/graphMailAttachments.js', () => ({ addGraphAttachment: attachMock }));

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() } }));
const appendToSent = vi.hoisted(() => vi.fn());
vi.mock('../index.js', () => ({ imapManager: { appendToSent, syncFolderOnDemand: vi.fn(), upsertSentMessageRecord: vi.fn() } }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import express from 'express';
import routes from './send.js';
import { query as __mock_query } from '../services/db.js';
import { redisClient as __mock_redisClient } from '../services/redis.js';
import { createAccountSmtpTransport as __mock_smtp } from '../services/smtpTransport.js';
import { resolveSentFolder as __mock_resolveSentFolder } from '../utils/mailUtils.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);
const redisClient = vi.mocked(__mock_redisClient);
const smtpFactory = vi.mocked(__mock_smtp);
const resolveSentFolder = vi.mocked(__mock_resolveSentFolder);

const account = {
  id: 'a1',
  user_id: 'u1',
  email_address: 'me@contoso.test',
  name: 'Me',
  mail_transport: 'microsoft_graph',
  provider_connection_id: 'connection-1',
  oauth_provider: 'microsoft',
};

let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => {
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
    if (sql.includes('INSERT INTO send_idempotency')) return { rows: [{ status: 'pending' }] };
    // The post-send recipient auto-learn is fire-and-forget; give it the rows it reads back so a passing
    // case logs no incidental error.
    if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book1' }] };
    if (sql.includes('INSERT INTO contacts')) return { rows: [{ address_book_id: 'book1' }] };
    return { rows: [] };
  });
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  redisClient.eval.mockResolvedValue(1);
  resolveSentFolder.mockResolvedValue('Sent');
  draftMock.mockResolvedValue({ id: 'AAMkAD-draft-1' });
  sendMock.mockResolvedValue({ status: 'accepted' });
  attachMock.mockResolvedValue({ id: 'att-1', strategy: 'direct' });
});

const post = (body: Record<string, unknown> = {}, idempotencyKey = 'graph-send-1') => fetch(`${base}/api/mail/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello', ...body }),
});

describe('sending from a native Microsoft Graph account', () => {
  it('stages a reply through the provider action when the answered message is in this mailbox', async () => {
    // MAIL-03: the RFC headers cannot be set in Graph's JSON payload, so the threading edge comes from the
    // provider's own reply action. The answered message has to be in the sending mailbox for that to be valid.
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts')) return { rows: [account] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('FROM messages m JOIN email_accounts')) {
        return {
          rows: [{
            message_id: '<parent@contoso.test>', canonical_message_id: null, in_reply_to: null,
            thread_references: null, provider_message_id: 'AAMkAD-parent-1', account_id: 'a1',
          }],
        };
      }
      if (sql.includes('INSERT INTO send_idempotency')) return { rows: [{ status: 'pending' }] };
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book1' }] };
      if (sql.includes('INSERT INTO contacts')) return { rows: [{ address_book_id: 'book1' }] };
      return { rows: [] };
    });

    const response = await post({ replyToMessageId: '11111111-1111-4111-8111-111111111111', sendKind: 'reply' });

    expect(response.status).toBe(200);
    // The ordinary "new message" draft is not used, and the reply action is the one that was taken.
    expect(draftMock).not.toHaveBeenCalled();
    expect(replyDraftMock).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-parent-1', 'reply');
    expect(patchDraftMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalled();
  });

  it('sends over Graph, with no SMTP transport and no IMAP APPEND', async () => {
    const response = await post({ cc: ['copy@example.com'], bcc: ['blind@example.com'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sentFolder: 'Sent' });

    expect(smtpFactory).not.toHaveBeenCalled();
    expect(appendToSent).not.toHaveBeenCalled();
    expect(draftMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-draft-1');

    // The canonical model — not nodemailer options and not a rendered MIME — is what reaches Graph, and
    // the blind recipient is structured data there rather than a header anywhere.
    const [api, composed] = draftMock.mock.calls[0] as unknown as [unknown, { bcc: Array<{ email: string }>; to: Array<{ email: string }>; cc: Array<{ email: string }>; messageId: string }];
    expect(api).toMatchObject({ userId: 'u1', connectionId: 'connection-1' });
    expect(composed.bcc).toEqual([{ email: 'blind@example.com' }]);
    expect(composed.to).toEqual([{ email: 'you@example.com' }]);
    expect(composed.cc).toEqual([{ email: 'copy@example.com' }]);
    expect(composed.messageId).toMatch(/^<.+@contoso\.test>$/);
  });

  it.each([
    ['a transient provider answer', 429, 'RATE_LIMITED', true, 429],
    ['a permanent provider answer', 403, 'ErrorAccessDenied', false, 403],
  ])('releases both gates on %s, so the same key can make a deliberate retry', async (_label, httpStatus, code, retryable, expectedStatus) => {
    sendMock.mockResolvedValue({ status: 'refused', httpStatus, code, message: 'nope', retryable } as never);

    const response = await post();
    expect(response.status).toBe(expectedStatus);
    expect((await response.json()) as JsonBody).toMatchObject({ code, ...(retryable ? { retryable: true } : {}) });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM send_idempotency'), expect.any(Array));
    expect(redisClient.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.anything());
  });

  it('reports a staging failure as a retryable refusal without an unknown send', async () => {
    draftMock.mockRejectedValueOnce(new Error('graph unavailable'));

    const response = await post();
    expect(response.status).toBe(502);
    expect((await response.json()) as JsonBody).toMatchObject({ code: 'DRAFT_CREATE_FAILED', retryable: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM send_idempotency'), expect.any(Array));
  });

  it('keeps the durable uncertain intent when the outcome is unknown, and never re-dispatches', async () => {
    sendMock.mockResolvedValue({ status: 'outcome_unknown', reason: 'socket hang up' } as never);

    const response = await post();
    expect(response.status).toBe(502);
    expect((await response.json()) as JsonBody).toMatchObject({ code: 'SEND_OUTCOME_UNKNOWN' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'uncertain'"), expect.any(Array));
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM send_idempotency'), expect.any(Array));
    expect(redisClient.eval).not.toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), expect.anything());
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('attaches every attachment to the draft before the send', async () => {
    const response = await post({
      attachments: [{ filename: 'notes.txt', content: Buffer.from('hello').toString('base64'), contentType: 'text/plain' }],
    });
    expect(response.status).toBe(200);
    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-draft-1', expect.objectContaining({ filename: 'notes.txt' }));
    // Draft, then attachments, then send — in that order.
    const order = [draftMock.mock.invocationCallOrder[0], attachMock.mock.invocationCallOrder[0], sendMock.mock.invocationCallOrder[0]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
