import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ImapManager } from '../services/imapManager.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: { headers: Record<string, string>; session?: { userId?: string } }, _res: unknown, next: () => void) => { req.session = { userId: 'user-1' }; next(); },
}));
type AppendDraftToFolder = (...args: Parameters<ImapManager['appendToFolder']>) => Promise<{ uid: number | null; folder: string; uidValidity?: number | null }>;

type ImapManagerMock = {
  appendToFolder: Mock<AppendDraftToFolder>;
  upsertDraftMessageRecord: Mock<ImapManager['upsertDraftMessageRecord']>;
  permanentDeleteMessage: Mock<ImapManager['permanentDeleteMessage']>;
};

const imapManager = vi.hoisted<ImapManagerMock>(() => ({
  appendToFolder: vi.fn<AppendDraftToFolder>(),
  upsertDraftMessageRecord: vi.fn<ImapManager['upsertDraftMessageRecord']>(),
  permanentDeleteMessage: vi.fn<ImapManager['permanentDeleteMessage']>(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query as __mock_query } from '../services/db.js';
import type { Server } from 'node:http';
import { listeningPort } from '../test/net.js';

// Access Vitest mock helpers with the query function's original signature.
const query = vi.mocked(__mock_query);

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailflow.sh', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {},
};
const SECOND_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_ACCOUNT_ROW = {
  ...ACCOUNT_ROW, id: SECOND_ACCOUNT_ID, email_address: 'second@example.test', name: 'Second',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', draftRoutes);
  return app;
}

describe('POST /api/mail/draft — local row persistence', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${listeningPort(server)}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID,
        to: ['Mike Scanlan <mike@scanlan.ai>'],
        cc: [],
        subject: 'Re: MailFlow hero',
        body: 'hello mike',
        bodyIsHtml: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });

    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledTimes(1);
    const [acct, folder, uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(acct.id).toBe(ACCOUNT_ID);
    expect(folder).toBe('Drafts');
    expect(uid).toBe(5);
    expect(meta.to).toEqual([{ name: 'Mike Scanlan', email: 'mike@scanlan.ai' }]);
    expect(meta.subject).toBe('Re: MailFlow hero');
    expect(meta.fromEmail).toBe('matthias@mailflow.sh');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailflow\.sh>$/);
    expect(meta.draftComposition).toMatchObject({ version: 2, authoredBody: 'hello mike', bodyIsHtml: false, signatureHtml: null, signatureText: null });
  });

  it('persists reply headers and separately editable draft composition (V10-04/V10-05)', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, subject: 'Re: x', body: 'author text', bodyIsHtml: false, editedSignature: '', quotedBody: 'old quote', inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledWith(expect.anything(), 'Drafts', 5, expect.objectContaining({
      inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>',
      draftComposition: { version: 2, authoredBody: 'author text', bodyIsHtml: false, signatureHtml: null, signatureText: null, quotedBody: 'old quote', quotedBodyHtml: null },
    }));
  });

  it('persists BCC recipients with a reopened draft without exposing them as To or CC (V9-03)', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['hidden@example.test'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledWith(expect.anything(), 'Drafts', 5, expect.objectContaining({
      to: [{ name: '', email: 'to@example.test' }],
      cc: [{ name: '', email: 'cc@example.test' }],
      bcc: [{ name: '', email: 'hidden@example.test' }],
    }));
  });

  it('rejects an unavailable selected alias instead of falling back to the primary sender (V10-03)', async () => {
    query.mockReset().mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      if (statement.includes('SELECT * FROM email_accounts WHERE id = $1')) return { rows: [ACCOUNT_ROW] };
      if (statement.includes('SELECT * FROM account_aliases')) return { rows: [] };
      return { rows: [] };
    });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, aliasId: '33333333-3333-4333-8333-333333333333', subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(409);
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });

  it('still returns success if the local row persistence throws (append already stored it)', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
  });

  it('does not persist a row when the append returns no uid (no reliable key)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });

  it('deletes a replaced draft through its original account identity, never the selected sender (V7-02)', async () => {
    query.mockReset().mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes('SELECT id FROM email_accounts')) return { rows: [{ id: SECOND_ACCOUNT_ID }] };
      if (statement.includes('SELECT * FROM email_accounts WHERE id = $1')) {
        return { rows: [params?.[0] === ACCOUNT_ID ? ACCOUNT_ROW : SECOND_ACCOUNT_ROW] };
      }
      if (statement.includes('SELECT draft_uid_validity FROM messages')) return { rows: [{ draft_uid_validity: 42 }] };
      if (statement.includes('FROM folders')) return { rows: [{ path: 'Drafts' }] };
      return { rows: [] };
    });
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: 9, folder: 'Drafts' });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: SECOND_ACCOUNT_ID, to: ['a@b.com'], subject: 'replacement', body: 'body',
        existingDraft: { accountId: ACCOUNT_ID, uid: 5, folder: 'Drafts', uidValidity: 42 },
      }),
    });

    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT_ID }), 5, 'Drafts', 42,
    );
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: SECOND_ACCOUNT_ID }), 5, 'Drafts', 42,
    );
    const localDelete = query.mock.calls.find(([statement]) => statement.includes('DELETE FROM messages'));
    expect(localDelete?.[1]).toEqual([ACCOUNT_ID, 5, 'Drafts', 42]);
  });

  it('retains a replaced draft when its cached UIDVALIDITY differs from the historical identity (V8-01)', async () => {
    query.mockReset().mockImplementation(async (statement: string, _params?: unknown[]) => {
      if (statement.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      if (statement.includes('SELECT * FROM email_accounts WHERE id = $1')) return { rows: [ACCOUNT_ROW] };
      if (statement.includes('SELECT draft_uid_validity FROM messages')) return { rows: [{ draft_uid_validity: 43 }] };
      if (statement.includes('FROM folders')) return { rows: [{ path: 'Drafts' }] };
      return { rows: [] };
    });
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: 10, folder: 'Drafts', uidValidity: 43 });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'replacement', body: 'body', existingDraft: { accountId: ACCOUNT_ID, uid: 5, folder: 'Drafts', uidValidity: 42 } }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([statement]) => statement.includes('DELETE FROM messages'))).toBe(false);
  });

  it('retains the previous draft when APPEND does not return a new UID (V7-02)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y',
        existingDraft: { accountId: ACCOUNT_ID, uid: 5, folder: 'Drafts', uidValidity: 42 },
      }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});
