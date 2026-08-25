import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation settings and interaction contract', () => {
  it('exposes exactly the two canonical conversation controls with per-option descriptions', () => {
    const source = readFileSync(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');
    assert.equal((source.match(/conversation\.conversationReader/g) || []).length, 1);
    assert.match(source, /conversation\.readerOff/);
    assert.match(source, /conversation\.readerOffDesc/);
    assert.match(source, /conversation\.readerOn/);
    assert.match(source, /conversation\.readerOnDesc/);
    assert.match(source, /setThreadedView/);
    assert.doesNotMatch(source, /conversation_list_view_enabled/);
  });

  it('keeps grouped parent/child selection on the native MessagePane contract', () => {
    const app = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    const list = readFileSync(new URL('./ConversationList.jsx', import.meta.url), 'utf8');
    // Reader OFF: openConversationTarget must resolve a physical message and select it
    // so MessagePane shows content instead of the empty state.
    assert.match(app, /api\.resolveMessage\(physicalId\)/);
    assert.match(app, /api\.getMessage\(physicalId\)/);
    assert.match(app, /setSelectedMessage/);
    // Reader ON: ConversationPane is rendered in the same pane container as MessagePane.
    assert.match(app, /conversationReaderViewEnabled && conversationId \? <ConversationPane/);
    assert.match(app, /: <MessagePane/);
    // ConversationList child rows pass logical_message_id and latestCopyId.
    assert.match(list, /logical_message_id: message\.id/);
    assert.match(list, /latestCopyId: message\.latestCopyId/);
    // Chevron stopPropagation so it toggles expand only, not selection.
    assert.match(list, /e\.stopPropagation\(\); toggleExpand/);
  });
});
