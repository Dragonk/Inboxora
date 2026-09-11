import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  withTransaction: vi.fn(),
}));
vi.mock('./conversationOverridePolicy.js', () => ({
  resolveConversationAlias: vi.fn(async (_client, { conversationId }) => conversationId),
}));
vi.mock('../utils/mailUtils.js', () => ({
  adjustFolderCounts: vi.fn(),
}));

import { COPY_SCOPES, applyConversationAction, applyBulkConversationAction } from './conversationActions.js';
import { withTransaction } from './db.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT account_id FROM conversations')) return { rows: [{ account_id: 'account-1' }] };
      if (sql.includes('SELECT m.id, m.account_id, m.logical_message_id, m.conversation_id')) {
        return { rows: [{ id: 'copy-1', account_id: 'account-1', logical_message_id: 'logical-1', conversation_id: 'conversation-1', folder: 'INBOX' }] };
      }
      if (sql.includes('UPDATE messages SET is_read')) return { rows: [{ id: 'copy-1', is_read: false }], rowCount: 1 };
      if (sql.includes('UPDATE messages SET is_starred')) return { rows: [{ id: 'copy-1', is_starred: true }], rowCount: 1 };
      if (sql.includes('UPDATE conversations c SET')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('conversation copy-aware actions', () => {
  beforeEach(() => withTransaction.mockReset());
  it('exposes exactly the four explicit copy scopes', () => {
    expect([...COPY_SCOPES]).toEqual([
      'THIS_COPY',
      'ALL_COPIES_OF_LOGICAL_MESSAGE',
      'COPIES_ON_THIS_ACCOUNT',
      'WHOLE_CONVERSATION',
    ]);
  });

  it('passes selected copy and scope through to a transactional read action', async () => {
    const client = fakeClient();
    withTransaction.mockImplementationOnce(async fn => fn(client));
    const result = await applyConversationAction({
      userId: 'user-1', conversationId: 'conversation-1', copyId: 'copy-1',
      scope: 'THIS_COPY', action: 'read', isRead: false,
    });
    expect(result).toMatchObject({ ok: true, action: 'read', scope: 'THIS_COPY', affectedCount: 1, selectedCopyId: 'copy-1' });
    expect(client.calls.some(call => call.sql.includes('UPDATE messages SET is_read'))).toBe(true);
  });

  it('broadcasts a physical message flag update after a conversation read action', async () => {
    const client = fakeClient();
    const imapManager = { broadcast: vi.fn() };
    withTransaction.mockImplementationOnce(async fn => fn(client));

    await applyConversationAction({
      userId: 'user-1', conversationId: 'conversation-1', copyId: 'copy-1',
      scope: 'THIS_COPY', action: 'read', isRead: false, imapManager,
    });

    expect(imapManager.broadcast).toHaveBeenCalledWith({
      type: 'message_flags',
      accountId: 'account-1',
      changes: [{ id: 'copy-1', is_read: false }],
    }, 'user-1');
  });

  it('requires row selectors for selector-dependent bulk scopes', async () => {
    await expect(applyBulkConversationAction({
      userId: 'user-1', conversationIds: ['conversation-1'], scope: 'COPIES_ON_THIS_ACCOUNT', action: 'delete',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts per-row copy selectors for bulk scopes', async () => {
    const client = fakeClient();
    withTransaction.mockImplementationOnce(async fn => fn(client));
    const result = await applyBulkConversationAction({
      userId: 'user-1',
      items: [{ conversationId: 'conversation-1', copyId: 'copy-1', logicalMessageId: 'logical-1' }],
      scope: 'ALL_COPIES_OF_LOGICAL_MESSAGE',
      action: 'read',
      isRead: true,
    });
    expect(result).toMatchObject({ ok: true, scope: 'ALL_COPIES_OF_LOGICAL_MESSAGE', affectedCount: 1 });
  });

  it('uses the provider move path and refuses a missing destination folder', async () => {
    const client = fakeClient();
    client.query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: 'account-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'copy-1', account_id: 'account-1', logical_message_id: 'logical-1', conversation_id: 'conversation-1', folder: 'INBOX', uid: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'copy-1', account_id: 'account-1', logical_message_id: 'logical-1', conversation_id: 'conversation-1', folder: 'INBOX', uid: 7 }] })
      .mockResolvedValueOnce({ rows: [{ path: 'Archive', special_use: '\\Archive' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'copy-1', folder: 'Archive' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const imapManager = {
      bulkMoveMessages: vi.fn().mockResolvedValue({ succeeded: [7], failed: [], uidMap: new Map([[7, 99]]) }),
      syncFolderOnDemand: vi.fn(),
    };
    withTransaction.mockImplementationOnce(async fn => fn(client));
    const result = await applyConversationAction({
      userId: 'user-1', conversationId: 'conversation-1', copyId: 'copy-1',
      scope: 'THIS_COPY', action: 'move', targetFolder: 'Archive', imapManager,
    });
    expect(result.affectedCount).toBe(1);
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'account-1' }), [7], 'INBOX', 'Archive');
  });

  it('rejects an implicit/unknown scope before any transaction work', async () => {
    await expect(applyConversationAction({
      userId: 'user-1', conversationId: 'conversation-1', scope: 'WHOLE_THREAD', action: 'delete',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });
});