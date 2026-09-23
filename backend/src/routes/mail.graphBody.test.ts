// The reading half of the Graph adapter, asserted at the route: a native message's
// body and attachments come from Microsoft Graph, the result is cached in the same
// columns the IMAP path uses, and an IMAP account is untouched.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetchGraphMessageBody: vi.fn(),
  fetchGraphAttachments: vi.fn(),
  collectGraphInlineImages: vi.fn(),
  fetchGraphAttachmentBytes: vi.fn(),
  noteUserActivity: vi.fn(),
  fetchMessageBody: vi.fn(),
  fetchAttachment: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    noteUserActivity: mocks.noteUserActivity,
    fetchMessageBody: mocks.fetchMessageBody,
    fetchAttachment: mocks.fetchAttachment,
    broadcast: vi.fn(),
    setFlag: vi.fn(),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
  isMicrosoftConfigured: () => true,
}));
vi.mock('../services/providers/microsoft/graphMailBody.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providers/microsoft/graphMailBody.js')>();
  return {
    ...actual,
    fetchGraphMessageBody: mocks.fetchGraphMessageBody,
    fetchGraphAttachments: mocks.fetchGraphAttachments,
    collectGraphInlineImages: mocks.collectGraphInlineImages,
    fetchGraphAttachmentBytes: mocks.fetchGraphAttachmentBytes,
  };
});

import express from 'express';
import mailRoutes from './mail.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    uid: 42,
    folder: 'INBOX',
    provider_message_id: 'AAMkAD-1',
    message_id: null,
    is_read: false,
    is_starred: false,
    attachments: JSON.stringify([{ part: 'att-1', filename: 'plan.pdf', type: 'application/pdf', size: 11 }]),
    body_html: null,
    body_text: null,
    ...overrides,
  };
}

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
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.collectGraphInlineImages.mockResolvedValue([]);
});

describe('a Graph message body is read from the provider and cached', () => {
  it('fetches, sanitises, caches and returns the HTML with its attachments', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })                       // message lookup
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 }); // account lookup
    mocks.fetchGraphMessageBody.mockResolvedValue({ contentType: 'html', content: '<p>Quarterly <b>plan</b></p>' });
    mocks.fetchGraphAttachments.mockResolvedValue([
      { id: 'att-1', name: 'plan.pdf', contentType: 'application/pdf', size: 11 },
      { id: 'inline-1', name: 'logo.png', contentType: 'image/png', isInline: true, contentId: 'logo@x' },
    ]);

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { html: string; attachments: Array<{ part: string }> };
    expect(payload.html).toContain('Quarterly');
    expect(payload.html).not.toContain('<script');
    // The inline image is not offered as a file to download.
    expect(payload.attachments.map(attachment => attachment.part)).toEqual(['att-1']);

    // The body is cached in the same columns the IMAP path writes.
    const cache = mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET body_html = $1'));
    expect(cache).toBeDefined();
    expect(String(cache?.[1]?.[0])).toContain('Quarterly');
    expect(JSON.parse(String(cache?.[1]?.[2]))).toHaveLength(1);
    expect(mocks.noteUserActivity).not.toHaveBeenCalled();
  });

  it('returns a fetched Graph body when attachment metadata fails, without caching an empty list', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    const { GraphApiError } = await import('../services/providers/microsoft/graphApiClient.js');
    mocks.fetchGraphMessageBody.mockResolvedValue({ contentType: 'text', content: 'available body' });
    mocks.fetchGraphAttachments.mockRejectedValue(new GraphApiError({ code: 'RATE_LIMITED', message: 'slow down', status: 429, retryable: true }));

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      text: 'available body', attachments: [], attachmentsIncomplete: true,
      attachmentError: { code: 'RATE_LIMITED', retryable: true },
    });
    const cache = mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET body_html = $1'));
    expect(cache?.[1]?.[2]).toBeNull();
    // A later read must fetch attachment metadata again rather than treating this
    // body-only cache as proof that the message has no attachments.
    expect(cache?.[1]?.[5]).toBe(false);
    expect(mocks.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('does not fall through to IMAP for a Graph account', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    mocks.fetchGraphMessageBody.mockResolvedValue({ contentType: 'text', content: 'plain body' });
    mocks.fetchGraphAttachments.mockResolvedValue([]);

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'plain body', html: null });
    expect(mocks.fetchMessageBody).not.toHaveBeenCalled();
    expect(mocks.noteUserActivity).not.toHaveBeenCalled();
  });

  it('leaves an IMAP account on the IMAP path', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow({ provider_message_id: null })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, mail_transport: 'imap_smtp' }], rowCount: 1 });
    mocks.fetchMessageBody.mockResolvedValue({ html: '<p>from imap</p>', text: 'from imap', attachments: [] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(response.status).toBe(200);
    expect(mocks.fetchMessageBody).toHaveBeenCalled();
    expect(mocks.fetchGraphMessageBody).not.toHaveBeenCalled();
  });

  it('reports a missing message as gone rather than as a server error', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    const { GraphApiError } = await import('../services/providers/microsoft/graphApiClient.js');
    mocks.fetchGraphMessageBody.mockRejectedValue(new GraphApiError({ code: 'RESOURCE_NOT_FOUND', message: 'gone', status: 404 }));
    mocks.fetchGraphAttachments.mockResolvedValue([]);

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('a Graph attachment downloads by its provider id', () => {
  it('streams the decoded bytes with the stored metadata', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    mocks.fetchGraphAttachmentBytes.mockResolvedValue(Buffer.from('hello world', 'utf8'));

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/attachments/att-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('plan.pdf');
    expect(await response.text()).toBe('hello world');
    expect(mocks.fetchAttachment).not.toHaveBeenCalled();
    // The size ceiling the IMAP path enforces is applied to the Graph fetch too.
    expect(mocks.fetchGraphAttachmentBytes).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-1', 'att-1', 50 * 1024 * 1024);
  });

  it('answers not found for a part the message does not have', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 });
    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/attachments/att-9`);
    expect(response.status).toBe(404);
    expect(mocks.fetchGraphAttachmentBytes).not.toHaveBeenCalled();
  });
});

describe('the attachment zip asks the provider for each file', () => {
  it('bundles the Graph attachments without touching IMAP', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });
    mocks.fetchGraphAttachmentBytes.mockResolvedValue(Buffer.from('hello world', 'utf8'));

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/attachments.zip`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('zip');
    const body = Buffer.from(await response.arrayBuffer());
    // A zip starts with the local file header signature; that it is non-empty and
    // well-formed is enough here — the naming and archive code is shared with IMAP.
    expect(body.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(mocks.fetchGraphAttachmentBytes).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-1', 'att-1', 50 * 1024 * 1024);
    expect(mocks.fetchAttachment).not.toHaveBeenCalled();
  });

  it('refuses a Graph message that carries no provider identity', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [messageRow({ provider_message_id: null })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1', mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }], rowCount: 1 });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/attachments.zip`);
    expect(response.status).toBe(409);
    expect(mocks.fetchGraphAttachmentBytes).not.toHaveBeenCalled();
  });
});
