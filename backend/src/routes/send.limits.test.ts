import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { JsonBody } from '../test/json.js';

/**
 * P06 at the route: the limits belong to the transport an account sends over.
 *
 * The three cases that matter and are not covered elsewhere:
 *  - a Graph attachment above the SMTP-era 25 MB reaches the provider instead of being refused by a constant;
 *  - an installation ceiling still refuses, and does so **before** the send intent is claimed or any provider
 *    call is made, so a size refusal can never be mistaken for an unknown outcome;
 *  - a Gmail message whose attachments fit is refused for its *raw* size, which only the provider's own
 *    measurement can see.
 */
const draftMock = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-draft-1' })));
const graphSendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' as const })));
const attachMock = vi.hoisted(() => vi.fn(async () => ({ id: 'att-1', strategy: 'direct' as const })));
const gmailSendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'accepted' as const })));
vi.mock('../services/providers/microsoft/graphMailSend.js', () => ({ createGraphDraft: draftMock, sendGraphDraft: graphSendMock }));
vi.mock('../services/providers/microsoft/graphMailAttachments.js', () => ({ addGraphAttachment: attachMock }));
vi.mock('../services/providers/google/gmailMailSend.js', () => ({ sendGmailRawMessage: gmailSendMock }));

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
import { resolveSentFolder as __mock_resolveSentFolder } from '../utils/mailUtils.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);
const redisClient = vi.mocked(__mock_redisClient);
const resolveSentFolder = vi.mocked(__mock_resolveSentFolder);

const MIB = 1024 * 1024;

const graphAccount = {
  id: 'a1',
  user_id: 'u1',
  email_address: 'me@contoso.test',
  name: 'Me',
  mail_transport: 'microsoft_graph',
  provider_connection_id: 'connection-1',
  oauth_provider: 'microsoft',
};

const gmailAccount = {
  ...graphAccount,
  id: 'g1',
  email_address: 'me@gmail.test',
  mail_transport: 'gmail_api',
  provider_connection_id: 'google-connection-1',
  oauth_provider: 'google',
};

let currentAccount: typeof graphAccount = graphAccount;
let server: Server, base: string;

beforeAll(async () => {
  const app = express();
  // The real route's window, so a case can carry a provider-sized attachment through the parser.
  app.use(express.json({ limit: '210mb' }));
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  vi.clearAllMocks();
  currentAccount = graphAccount;
  delete process.env.MAIL_MAX_ATTACHMENT_BYTES;
  query.mockImplementation(async sql => {
    if (sql.includes('FROM email_accounts')) return { rows: [currentAccount] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
    if (sql.includes('INSERT INTO send_idempotency')) return { rows: [{ status: 'pending' }] };
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
  graphSendMock.mockResolvedValue({ status: 'accepted' });
  attachMock.mockResolvedValue({ id: 'att-1', strategy: 'direct' });
  gmailSendMock.mockResolvedValue({ status: 'accepted' });
});

const post = (accountId: string, body: Record<string, unknown>, idempotencyKey: string) => fetch(`${base}/api/mail/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
  body: JSON.stringify({ accountId, to: ['you@example.com'], subject: 'Test', body: 'Hello', ...body }),
});

describe('the send-limits endpoint', () => {
  it('reports the transport’s effective limits, with no ceiling as null rather than Infinity', async () => {
    const graph = await fetch(`${base}/api/mail/send-limits?accountId=a1`);
    expect(graph.status).toBe(200);
    expect(await graph.json()).toMatchObject({
      transport: 'microsoft_graph',
      limits: {
        singleAttachmentBytes: 150 * MIB,
        totalAttachmentBytes: 150 * MIB,
        uploadSessionThresholdBytes: 3 * MIB,
        providerUploadFileBytes: 150 * MIB,
        // Graph posts no raw message, so it has no such ceiling; `null` says so and stops a client reading
        // `Infinity` as absent.
        providerRawMessageBytes: null,
      },
    });

    currentAccount = gmailAccount;
    const gmail = await fetch(`${base}/api/mail/send-limits?accountId=g1`);
    expect(await gmail.json()).toMatchObject({
      transport: 'gmail_api',
      limits: { providerRawMessageBytes: 25 * MIB, uploadSessionThresholdBytes: null },
    });
  });

  it('requires an account and refuses one that is not the caller’s', async () => {
    expect((await fetch(`${base}/api/mail/send-limits`)).status).toBe(400);
    query.mockResolvedValueOnce({ rows: [] });
    expect((await fetch(`${base}/api/mail/send-limits?accountId=a1`)).status).toBe(404);
  });
});

describe('the send limits at the route', () => {
  it('carries a Graph attachment above the SMTP-era 25 MB through to the provider', { timeout: 30_000 }, async () => {
    // 26 MiB: one megabyte above the number that used to refuse every transport.
    const content = Buffer.alloc(26 * MIB, 7).toString('base64');
    const response = await post('a1', { attachments: [{ filename: 'big.bin', content }] }, 'p06-graph-big');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sentFolder: 'Sent' });
    expect(attachMock).toHaveBeenCalledOnce();
    // (api, draftId, attachment): the third argument is the file the route measured.
    const call = attachMock.mock.calls[0] as unknown as unknown[] | undefined;
    const attached = call?.[2] as { content?: Buffer; filename?: string } | undefined;
    expect(attached?.filename).toBe('big.bin');
    expect(attached?.content?.length).toBe(26 * MIB);
    expect(graphSendMock).toHaveBeenCalledOnce();
  });

  it('refuses an attachment above the installation ceiling before any provider call or intent', async () => {
    process.env.MAIL_MAX_ATTACHMENT_BYTES = '1000';
    const content = Buffer.alloc(2000, 7).toString('base64');
    const response = await post('a1', { attachments: [{ filename: 'too-big.bin', content }] }, 'p06-graph-instance');

    expect(response.status).toBe(413);
    const body = await response.json() as JsonBody & { dimension?: string; transport?: string; actualBytes?: number; limitBytes?: number; filename?: string };
    expect(body).toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
      dimension: 'attachment',
      transport: 'microsoft_graph',
      filename: 'too-big.bin',
      actualBytes: 2000,
      limitBytes: 1000,
    });
    // Nothing left the process and nothing durable was claimed: a size refusal is not an unknown outcome.
    expect(draftMock).not.toHaveBeenCalled();
    expect(graphSendMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO send_idempotency'), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("status = 'uncertain'"), expect.anything());
  });

  it('refuses a Gmail message whose attachments fit but whose raw message does not', async () => {
    currentAccount = gmailAccount;
    // 20 MiB of attachments is inside Gmail's own attachment accounting; the rendered raw message is not.
    const content = Buffer.alloc(20 * MIB, 3).toString('base64');
    const response = await post('g1', { attachments: [{ filename: 'big.bin', content }] }, 'p06-gmail-raw');

    expect(response.status).toBe(413);
    const body = await response.json() as JsonBody & { dimension?: string; transport?: string; limitBytes?: number };
    expect(body).toMatchObject({
      code: 'PROVIDER_MESSAGE_TOO_LARGE',
      dimension: 'provider_raw_message',
      transport: 'gmail_api',
      limitBytes: 25 * MIB,
    });
    expect(gmailSendMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO send_idempotency'), expect.anything());
  }, 30_000);
});
