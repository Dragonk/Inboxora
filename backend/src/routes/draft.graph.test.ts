import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { JsonBody } from '../test/json.js';

// A native Microsoft account's draft is the provider's own message object: created or patched over
// Graph, mirrored locally by provider id, and removed with the provider first. No IMAP call happens.
const createDraft = vi.hoisted(() => vi.fn(async () => ({ id: 'AAMkAD-draft-1' })));
const renderedPayload = vi.hoisted(() => vi.fn(() => ({ subject: 'rendered' })));
vi.mock('../services/providers/microsoft/graphMailSend.js', () => ({
  createGraphDraft: createDraft,
  renderGraphMessage: renderedPayload,
}));

const { patchDraft, deleteMessage, FakeGraphApiError } = vi.hoisted(() => {
  const patchDraft = vi.fn();
  const deleteMessage = vi.fn(async () => undefined);
  class FakeGraphApiError extends Error {
    constructor(readonly code: string, message = code) { super(message); }
  }
  return { patchDraft, deleteMessage, FakeGraphApiError };
});
vi.mock('../services/providers/microsoft/graphApiClient.js', () => ({
  graphPatch: patchDraft,
  GraphApiError: FakeGraphApiError,
}));
vi.mock('../services/providers/microsoft/graphMailMutations.js', () => ({ graphDeleteMessage: deleteMessage }));

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query as __mock_query } from '../services/db.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

const query = vi.mocked(__mock_query);

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const GRAPH_ACCOUNT = {
  id: ACCOUNT_ID,
  user_id: 'user-1',
  email_address: 'sam@contoso.test',
  name: 'Sam',
  sender_name: null,
  signature: null,
  folder_mappings: {},
  mail_transport: 'microsoft_graph',
  provider_connection_id: 'connection-1',
};

let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', draftRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${listeningPort(server)}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

const prevEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.MS_CLIENT_ID = 'test-client';
  process.env.PROVIDER_INTEGRATIONS_ENABLED = '1';
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [GRAPH_ACCOUNT] };
    if (sql.includes('special_use =')) return { rows: [{ path: 'Drafts' }] };
    if (sql.includes('mail_transport, provider_connection_id')) {
      return { rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }] };
    }
    if (sql.includes('SELECT provider_message_id FROM messages')) return { rows: [{ provider_message_id: 'AAMkAD-existing' }] };
    if (sql.includes('INSERT INTO messages')) return { rows: [{ id: 'row-1', uid: '4242' }] };
    return { rows: [] };
  });
  createDraft.mockResolvedValue({ id: 'AAMkAD-draft-1' });
  patchDraft.mockResolvedValue({ id: 'AAMkAD-existing' });
});
afterEach(() => { process.env = { ...prevEnv }; });

const post = (body: Record<string, unknown>) => fetch(`${base}/api/mail/draft`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('saving a draft for a native Microsoft Graph account', () => {
  it('creates the draft on the provider, records the local row, and never appends over IMAP', async () => {
    const response = await post({ accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uid: '4242', folder: 'Drafts', uidValidity: null, rowId: 'row-1' });
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledOnce();

    // The canonical model reaches the provider, with no MIME and no SMTP rendering.
    const [, composed] = createDraft.mock.calls[0] as unknown as [unknown, { to: Array<{ email: string }>; bcc: unknown[] }];
    expect(composed.to).toEqual([{ email: 'you@example.com' }]);
    expect(composed.bcc).toEqual([]);

    const insert = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO messages'));
    expect(insert).toBeDefined();
    expect(insert![1]).toContain('AAMkAD-draft-1');
  });

  it('replaces an existing draft by patching the same provider object', async () => {
    const response = await post({
      accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body',
      existingDraft: { accountId: ACCOUNT_ID, uid: 4242, folder: 'Drafts' },
    });

    expect(response.status).toBe(200);
    expect(patchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-1' }),
      '/me/messages/AAMkAD-existing',
      expect.anything(),
    );
    // A replace is not create-then-delete: the provider id survives, so no second object exists.
    expect(createDraft).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('creates a fresh draft and removes the superseded one when the saved draft is gone at the provider', async () => {
    patchDraft.mockRejectedValueOnce(new FakeGraphApiError('RESOURCE_NOT_FOUND'));

    const response = await post({
      accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body',
      existingDraft: { accountId: ACCOUNT_ID, uid: 4242, folder: 'Drafts' },
    });

    expect(response.status).toBe(200);
    expect(createDraft).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-existing');
  });

  it('refuses when the provider layer is switched off', async () => {
    process.env.PROVIDER_INTEGRATIONS_ENABLED = '0';
    const response = await post({ accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body' });
    expect(response.status).toBe(403);
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('deleting a draft for a native Microsoft Graph account', () => {
  const remove = () => fetch(`${base}/api/mail/draft/4242?accountId=${ACCOUNT_ID}&folder=Drafts`, { method: 'DELETE' });

  it('removes the provider draft first, then the local row, without an IMAP call', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteMessage).toHaveBeenCalledWith(expect.anything(), 'AAMkAD-existing');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
  });

  it('treats a draft the provider no longer has as already removed', async () => {
    deleteMessage.mockRejectedValueOnce(new FakeGraphApiError('RESOURCE_NOT_FOUND'));
    const response = await remove();
    expect(response.status).toBe(200);
    expect((await response.json()) as JsonBody).toEqual({ ok: true });
  });

  it('refuses when the local row holds no provider identity', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [GRAPH_ACCOUNT] };
      if (sql.includes('special_use =')) return { rows: [{ path: 'Drafts' }] };
      if (sql.includes('mail_transport, provider_connection_id')) {
        return { rows: [{ id: ACCOUNT_ID, mail_transport: 'microsoft_graph', provider_connection_id: 'connection-1' }] };
      }
      if (sql.includes('SELECT provider_message_id FROM messages')) return { rows: [{ provider_message_id: null }] };
      return { rows: [] };
    });
    const response = await remove();
    expect(response.status).toBe(409);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
