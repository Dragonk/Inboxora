import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conversationDetailToThreadMessages,
  conversationListToThreadRows,
  preferredConversationCopy,
} from './conversationThreadAdapter.js';

describe('CE native ThreadRow adapter', () => {
  it('uses conversation identity and LogicalMessage count for the native parent', () => {
    const [row] = conversationListToThreadRows({ conversations: [{
      conversation_id: 'conversation-a', account_id: 'account-a', latest_copy_id: 'copy-5',
      canonical_subject: 'Golden', logical_message_count: 5, copy_count: 6, unread_count: 1,
      logical_messages: [{ id: 'lm-5', latestCopyId: 'copy-5', fromEmail: 'sender@test', snippet: 'latest' }],
    }] });
    assert.equal(row.thread_id, 'conversation-a');
    assert.equal(row.conversation_id, 'conversation-a');
    assert.equal(row.id, 'copy-5');
    assert.equal(row.message_count, 5);
    assert.equal(row.copy_count, 6);
    assert.equal(row.account_id, 'account-a');
  });

  it('emits one same-account preferred physical copy per LogicalMessage', () => {
    const detail = {
      summary: { conversation_id: 'conversation-a', account_id: 'account-a' },
      logicalMessages: [
        { id: 'lm-1', copies: [{ id: 'a-1', accountId: 'account-a', folder: 'INBOX' }, { id: 'b-1', accountId: 'account-b', folder: 'INBOX' }] },
        { id: 'lm-2', copies: [{ id: 'a-2-all', accountId: 'account-a', folder: 'All Mail' }, { id: 'a-2-sent', accountId: 'account-a', folder: 'Sent' }] },
      ],
    };
    const children = conversationDetailToThreadMessages(detail, 'INBOX');
    assert.deepEqual(children.map(child => child.id), ['a-1', 'a-2-sent']);
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.account_id === 'account-a'));
  });

  it('prefers the selected folder before Inbox/Sent and deterministic fallback', () => {
    const selected = preferredConversationCopy([
      { id: 'sent', accountId: 'account-a', folder: 'Sent', date: '2026-01-03' },
      { id: 'archive', accountId: 'account-a', folder: 'Archive', date: '2026-01-01' },
      { id: 'inbox', accountId: 'account-a', folder: 'INBOX', date: '2026-01-02' },
    ], 'account-a', 'Archive');
    assert.equal(selected.id, 'archive');
  });
});
