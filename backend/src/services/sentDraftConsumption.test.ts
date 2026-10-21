import { beforeEach, describe, expect, it, vi } from 'vitest';

// A delivered send consumes the draft it superseded: the provider object is removed and the local
// rows deleted, server-side, so a draft never survives the message it became. A removal that cannot
// be confirmed is reported as unconfirmed — the row is deliberately retained for the sync to reconcile.
const gmail = vi.hoisted(() => ({ find: vi.fn(), remove: vi.fn(), rowMessageId: vi.fn() }));
vi.mock('./providers/google/gmailMailDrafts.js', () => ({
  deleteGmailUserDraft: gmail.remove,
  findGmailDraftIdForMessage: gmail.find,
  gmailDraftMessageIdForLocalRow: gmail.rowMessageId,
}));
const graph = vi.hoisted(() => ({ remove: vi.fn(), rowDraftId: vi.fn() }));
vi.mock('./providers/microsoft/graphMailDrafts.js', () => ({
  deleteGraphUserDraft: graph.remove,
  graphDraftIdForLocalRow: graph.rowDraftId,
}));
const transport = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('./mailTransportTarget.js', () => ({ resolveMailTransportForSync: transport.resolve }));
const imapManager = vi.hoisted(() => ({ permanentDeleteMessage: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));
vi.mock('./db.js', () => ({ query: vi.fn() }));

import { consumeSentDraft, consumeSentDrafts } from './sentDraftConsumption.js';
import { query as __mock_query } from './db.js';

const query = vi.mocked(__mock_query);

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = {
  id: ACCOUNT_ID,
  user_id: 'user-1',
  email_address: 'sam@gmail.test',
  name: 'Sam',
  mail_transport: 'gmail_api',
  provider_connection_id: 'connection-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  ACCOUNT.mail_transport = 'gmail_api';
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [ACCOUNT] };
    if (sql.includes('JOIN email_accounts')) return { rows: [{ account_id: ACCOUNT_ID, uid: '42', folder: 'Drafts', draft_uid_validity: '7' }] };
    if (sql.includes('SELECT draft_uid_validity FROM messages')) return { rows: [{ draft_uid_validity: '7' }] };
    return { rows: [] };
  });
  transport.resolve.mockResolvedValue({ kind: 'gmail', connectionId: 'connection-1', config: { clientId: 'client-1' } });
  gmail.rowMessageId.mockResolvedValue('msg-1');
  gmail.find.mockResolvedValue('draft-1');
  gmail.remove.mockResolvedValue({ alreadyGone: false });
  graph.rowDraftId.mockResolvedValue('AAMkAD-draft-1');
  graph.remove.mockResolvedValue(undefined);
  imapManager.permanentDeleteMessage.mockResolvedValue(undefined);
});

const identity = { accountId: ACCOUNT_ID, uid: '42', folder: 'Drafts' };

describe('consuming a superseded Gmail draft', () => {
  it('removes the provider draft and the local row', async () => {
    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(true);

    expect(gmail.find).toHaveBeenCalledWith(expect.anything(), 'msg-1', { attempts: 3, delayMs: 400 });
    expect(gmail.remove).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }), 'draft-1');
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, '42', 'Drafts', 'msg-1']);
  });

  it('keeps the local row when the listing cannot confirm the draft', async () => {
    gmail.find.mockResolvedValue(null);

    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(false);

    expect(gmail.remove).not.toHaveBeenCalled();
    expect(query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'))).toBeUndefined();
  });

  it('removes the lone local row when it holds no provider identity', async () => {
    gmail.rowMessageId.mockResolvedValue(null);

    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(true);

    expect(gmail.find).not.toHaveBeenCalled();
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, '42', 'Drafts']);
  });
});

describe('consuming a superseded Graph draft', () => {
  it('removes the provider draft and the local row', async () => {
    ACCOUNT.mail_transport = 'microsoft_graph';
    transport.resolve.mockResolvedValue({ kind: 'graph', connectionId: 'connection-1', config: { clientId: 'client-1' } });

    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(true);

    expect(graph.remove).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'connection-1' }), 'AAMkAD-draft-1');
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, '42', 'Drafts', 'AAMkAD-draft-1']);
  });

  it('removes the lone local row when the draft id is not on the row', async () => {
    ACCOUNT.mail_transport = 'microsoft_graph';
    transport.resolve.mockResolvedValue({ kind: 'graph', connectionId: 'connection-1', config: { clientId: 'client-1' } });
    graph.rowDraftId.mockResolvedValue(null);

    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(true);

    expect(graph.remove).not.toHaveBeenCalled();
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, '42', 'Drafts']);
  });
});

describe('consuming a superseded IMAP draft', () => {
  it('removes the message only for an identity the stored UIDVALIDITY confirms', async () => {
    ACCOUNT.mail_transport = 'imap';

    await expect(consumeSentDraft('user-1', { ...identity, uidValidity: '7' })).resolves.toBe(true);

    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(ACCOUNT, 42, 'Drafts', 7);
    const deletion = query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'));
    expect(deletion).toBeDefined();
    expect(deletion![1]).toEqual([ACCOUNT_ID, '42', 'Drafts', 7]);
  });

  it('refuses an identity the stored UIDVALIDITY does not confirm', async () => {
    ACCOUNT.mail_transport = 'imap';

    await expect(consumeSentDraft('user-1', { ...identity, uidValidity: '8' })).resolves.toBe(false);

    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.find(call => String(call[0]).includes('DELETE FROM messages'))).toBeUndefined();
  });

  it('refuses an identity that carries no UIDVALIDITY at all', async () => {
    ACCOUNT.mail_transport = 'imap';

    await expect(consumeSentDraft('user-1', identity)).resolves.toBe(false);

    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});

describe('consuming the drafts a send supersedes', () => {
  it('deduplicates the composer identity and the draft row into one removal', async () => {
    await consumeSentDrafts('user-1', { existingDraft: { accountId: ACCOUNT_ID, uid: '42', folder: 'Drafts' }, draftMessageId: 'row-1' });

    expect(gmail.rowMessageId).toHaveBeenCalledOnce();
    expect(gmail.remove).toHaveBeenCalledOnce();
  });

  it('resolves the draft row of an MCP compose flow through its owning account', async () => {
    await consumeSentDrafts('user-1', { draftMessageId: 'row-1' });

    expect(gmail.rowMessageId).toHaveBeenCalledWith(ACCOUNT_ID, '42', 'Drafts');
    expect(gmail.remove).toHaveBeenCalledOnce();
  });

  it('ignores a draft row that does not exist, without failing the send', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [ACCOUNT] };
      return { rows: [] };
    });

    await expect(consumeSentDrafts('user-1', { draftMessageId: 'row-missing' })).resolves.toBeUndefined();
    expect(gmail.remove).not.toHaveBeenCalled();
  });

  it('survives a removal failure so a delivered message is never an error response', async () => {
    gmail.remove.mockRejectedValue(new Error('gmail refused'));

    await expect(consumeSentDrafts('user-1', { existingDraft: { accountId: ACCOUNT_ID, uid: '42', folder: 'Drafts' } })).resolves.toBeUndefined();
  });

  it('ignores an unusable composer identity rather than guessing', async () => {
    await consumeSentDrafts('user-1', { existingDraft: { accountId: ACCOUNT_ID, folder: 'Drafts' } });

    expect(gmail.rowMessageId).not.toHaveBeenCalled();
  });
});
