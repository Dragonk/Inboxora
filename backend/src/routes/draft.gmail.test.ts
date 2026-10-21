import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { JsonBody } from '../test/json.js';

// A native Gmail account's draft is the provider's own Draft object: saved over the Gmail API,
// mirrored locally by the message id the draft wraps, and removed at the provider first. No IMAP
// call happens, and the drafts.list identity lookup is bounded and retried before it is believed.
const gmailDrafts = vi.hoisted(() => ({
  save: vi.fn(),
  record: vi.fn(),
  find: vi.fn(),
  rowMessageId: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../services/providers/google/gmailMailDrafts.js', () => ({
  saveGmailUserDraft: gmailDrafts.save,
  upsertGmailDraftRecord: gmailDrafts.record,
  findGmailDraftIdForMessage: gmailDrafts.find,
  gmailDraftMessageIdForLocalRow: gmailDrafts.rowMessageId,
  deleteGmailUserDraft: gmailDrafts.remove,
}));
vi.mock('../services/providers/google/gmailMail.js', () => ({ gmailProviderNamespace: () => 'gmail:account-1' }));
vi.mock('../services/providers/microsoft/graphMailDrafts.js', () => ({
  deleteGraphUserDraft: vi.fn(),
  graphDraftIdForLocalRow: vi.fn(),
  saveGraphUserDraft: vi.fn(),
  upsertGraphDraftRecord: vi.fn(),
}));
vi.mock('../services/mailTransportTarget.js', () => ({
  resolveMailTransportForSync: vi.fn(async () => ({
    kind: 'gmail', connectionId: 'connection-1',
    config: { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://inboxora.example/cb' },
  })),
}));

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
const GMAIL_ACCOUNT = {
  id: ACCOUNT_ID,
  user_id: 'user-1',
  email_address: 'sam@gmail.test',
  name: 'Sam',
  sender_name: null,
  signature: null,
  folder_mappings: { drafts: 'Drafts' },
  mail_transport: 'gmail_api',
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

beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [GMAIL_ACCOUNT] };
    return { rows: [] };
  });
  gmailDrafts.save.mockResolvedValue({ id: 'draft-2', messageId: 'msg-2', threadId: 'thread-1', created: false });
  gmailDrafts.record.mockResolvedValue({ uid: '4242', rowId: 'row-2' });
  gmailDrafts.rowMessageId.mockResolvedValue('msg-1');
  gmailDrafts.find.mockResolvedValue('draft-1');
  gmailDrafts.remove.mockResolvedValue({ alreadyGone: false });
});

const post = (body: Record<string, unknown>) => fetch(`${base}/api/mail/draft`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const remove = () => fetch(`${base}/api/mail/draft/4242?accountId=${ACCOUNT_ID}&folder=Drafts`, { method: 'DELETE' });

describe('saving a draft for a native Gmail account', () => {
  it('creates the draft at the provider and records a single local row', async () => {
    const response = await post({ accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uid: '4242', folder: 'Drafts', uidValidity: null, rowId: 'row-2' });
    expect(gmailDrafts.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ existingDraftId: null }));
    expect(gmailDrafts.remove).not.toHaveBeenCalled();
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
    // A first save supersedes nothing, so no previous row is dropped.
    expect(query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'))).toBeUndefined();
  });

  it('updates the draft in place and drops the local row the autosave superseded', async () => {
    const response = await post({
      accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body',
      existingDraft: { accountId: ACCOUNT_ID, uid: 4242, folder: 'Drafts' },
    });

    expect(response.status).toBe(200);
    // The drafts.list lookup is retried before a just-saved draft is believed gone.
    expect(gmailDrafts.find).toHaveBeenCalledWith(expect.anything(), 'msg-1', { attempts: 3, delayMs: 750 });
    expect(gmailDrafts.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ existingDraftId: 'draft-1' }));
    expect(gmailDrafts.remove).not.toHaveBeenCalled();
    // Gmail mints a new message id per save, so the previous local row must not survive next to the new one.
    const superseded = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages') && String(call[0]).includes('id <> $4'));
    expect(superseded).toBeDefined();
    expect(superseded![1]).toEqual([ACCOUNT_ID, '4242', 'Drafts', 'row-2']);
  });

  it('removes the leaked provider draft a lagging listing missed', async () => {
    // The first listing lags the just-saved draft: the save creates a fresh provider draft while
    // the previous one still sits at Gmail. The late lookup finds it and removes it.
    gmailDrafts.find.mockResolvedValueOnce(null).mockResolvedValue('draft-stale');
    gmailDrafts.save.mockResolvedValue({ id: 'draft-2', messageId: 'msg-2', threadId: 'thread-1', created: true });

    const response = await post({
      accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Body',
      existingDraft: { accountId: ACCOUNT_ID, uid: 4242, folder: 'Drafts' },
    });

    expect(response.status).toBe(200);
    expect(gmailDrafts.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ existingDraftId: null }));
    expect(gmailDrafts.find).toHaveBeenCalledTimes(2);
    expect(gmailDrafts.find).toHaveBeenLastCalledWith(expect.anything(), 'msg-1', { attempts: 2, delayMs: 500 });
    expect(gmailDrafts.remove).toHaveBeenCalledWith(expect.anything(), 'draft-stale');
  });
});

describe('deleting a draft for a native Gmail account', () => {
  it('removes the provider draft first, then the local row, without an IMAP call', async () => {
    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // The lookup is retried before the draft is believed gone.
    expect(gmailDrafts.find).toHaveBeenCalledWith(expect.anything(), 'msg-1', { attempts: 3, delayMs: 500 });
    expect(gmailDrafts.remove).toHaveBeenCalledWith(expect.anything(), 'draft-1');
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, 4242, 'Drafts', 'msg-1']);
  });

  it('retains the local row when the listing cannot confirm the draft identity', async () => {
    gmailDrafts.find.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(409);
    expect((await response.json()) as JsonBody).toEqual({ error: 'Draft identity cannot be confirmed' });
    expect(gmailDrafts.remove).not.toHaveBeenCalled();
    // Dropping the row on an ambiguous miss is what let the next sync resurrect the draft.
    expect(query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'))).toBeUndefined();
  });

  it('refuses when the local row holds no provider identity', async () => {
    gmailDrafts.rowMessageId.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(409);
    expect(gmailDrafts.remove).not.toHaveBeenCalled();
  });
});
