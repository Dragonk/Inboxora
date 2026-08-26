import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
describe('native conversation 2x2 contract', () => {
  it('keeps one native list and one native pane for every preference pair', () => {
    const app = read('MailApp.jsx'); const list = read('MessageList.jsx');
    assert.match(app, /<MessageList\s*\/>/);
    assert.match(app, /conversationReaderViewEnabled\s*&&\s*conversationId\s*\?\s*['"]conversation['"]\s*:\s*['"]single['"]/);
    assert.match(list, /function ThreadRow/);
    assert.doesNotMatch(list, /GroupedConversationList/);
    assert.match(list, /accountOwnAddresses\(childAccount, msg\)/);
    assert.match(list, /MessageDirection direction=\{childDirection\}/);
    assert.match(list, /accounts=\{accounts\}/);
    assert.doesNotMatch(list, /accounts\.flatMap/);
    assert.match(list, /if \(threadedView\) params\.threaded = ['"]true['"]/);
    assert.match(list, /const threadKey = message\.thread_key \|\| message\.thread_id \|\| message\.id/);
    assert.match(list, /api\.getThread\(threadKey, effectiveFolder, false, message\.account_id \|\| selectedAccountId \|\| null\)/);
    assert.doesNotMatch(list, /conversationApi\.list/);
    assert.doesNotMatch(list, /conversationListToThreadRows/);
  });
  it('resolves every selected physical copy through the CE identity endpoint (OFF/ON blocker)', () => {
    const app = read('MailApp.jsx');
    assert.match(app, /conversationApi\.resolveMessage\(selectedMessageId, selected\?\.account_id \|\| null\)/);
    assert.match(app, /setConversationId\(resolved\.conversation_id\)/);
    assert.match(app, /setTargetLogicalMessageId\(resolved\.logical_message_id/);
    assert.match(app, /id: resolved\.physical_copy_id \|\| resolved\.id \|\| selectedMessageId/);
    assert.match(app, /accountId: resolved\.account_id \|\| resolved\.accountId \|\| null/);
    assert.match(app, /selectedConversationCopy=\{selectedConversationCopy\}/);
    assert.match(app, /thread_key: copy\.threadKey \|\| copy\.threadId \|\| null/);
    assert.match(app, /conversationId/);
    assert.match(app, /data-ce-resolution-error/);
    assert.match(app, /Conversation reader resolution failed/);
  });
  it('keeps compact native cards and delegates expanded physical-copy content to the shared renderer', () => {
    const reader = read('ConversationReader.jsx'); const item = read('ConversationMessage.jsx'); const detail = read('MessageDetailContent.jsx');
    assert.match(reader, /setExpanded\(initialConversationExpansion\(messages, targetLogicalMessageId\)\)/);
    assert.match(reader, /api\.getMessageBody\(physicalCopyId, remoteImages\)/);
    assert.match(reader, /filter\(copy => String\(copy\.accountId \?\? copy\.account_id\) === String\(selectedAccountId\)\)/);
    assert.match(item, /MessageToolbar/);
    assert.match(item, /preferredAccountCopy\(message, selectedAccountId, selectedCopyId\)/);
    assert.match(item, /physicalCopyId=\{copy\.id\}/);
    assert.match(item, /expanded && <div data-conversation-message-expanded-content/);
    assert.match(item, /<MessageDetailContent/);
    assert.match(detail, /<MessageBodyRenderer/);
    assert.match(detail, /showQuotedTextLabel=\{t\('conversation\.showQuotedText'\)\}/);
    assert.match(detail, /hideQuotedTextLabel=\{t\('conversation\.hideQuotedText'\)\}/);
    assert.match(detail, /data-message-detail-attachments/);
    assert.match(detail, /data-message-detail-download-all/);
    assert.match(detail, /data-message-detail-unsubscribe/);
    assert.match(detail, /data-message-detail-remote-images/);
    assert.match(detail, /data-physical-copy-id=\{physicalCopyId/);
  });

});
