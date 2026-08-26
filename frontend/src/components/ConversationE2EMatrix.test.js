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
  });
  it('resolves every selected physical copy through the CE identity endpoint (OFF/ON blocker)', () => {
    const app = read('MailApp.jsx');
    assert.match(app, /conversationApi\.resolveMessage\(selectedMessageId, selected\?\.account_id \|\| null\)/);
    assert.match(app, /setConversationId\(resolved\.conversation_id\)/);
    assert.match(app, /setTargetLogicalMessageId\(resolved\.logical_message_id/);
    assert.match(app, /id: resolved\.physical_copy_id \|\| resolved\.id \|\| selectedMessageId/);
    assert.match(app, /accountId: resolved\.account_id \|\| resolved\.accountId \|\| null/);
    assert.match(app, /selectedConversationCopy=\{selectedConversationCopy\}/);
    assert.match(app, /data-ce-resolution-error/);
    assert.match(app, /Conversation reader resolution failed/);
  });
  it('uses compact native-pane message cards and per-message reply targets', () => {
    const reader = read('ConversationReader.jsx'); const item = read('ConversationMessage.jsx');
    assert.match(reader, /messages\.some\(message => message\.id === targetLogicalMessageId\)/);
    assert.match(reader, /filter\(copy => copy\.accountId === selectedAccountId\)/);
    assert.match(reader, /sameAccountCopies\.find\(item => item\.id === selectedCopyId\)/);
    assert.doesNotMatch(reader, /message\.direction/);
    assert.match(reader, /const next = new Set\(previous\)/);
    assert.match(reader, /if \(next\.has\(id\)\) next\.delete\(id\)/);
    assert.match(reader, /else next\.add\(id\)/);
    assert.match(item, /MessageActionBar/);
    const presentation = read('MessagePresentation.jsx');
    assert.match(presentation, /data-conversation-message-actions/);
    assert.match(item, /logicalMessageId: message\.id/);
    assert.match(item, /preferredAccountCopy\(message, selectedAccountId, selectedCopyId\)/);
    assert.match(item, /physicalCopyDirection\(copy, account\)/);
    const direction = read('../utils/conversationDirection.js');
    assert.match(direction, /String\(copy\.accountId \?\? copy\.account_id\) !== String\(account\.id\)\) return null/);
    assert.doesNotMatch(item, /messageDirection\(message\.direction\)/);
    assert.match(item, /MessageBodyRenderer/);
    assert.match(item, /data-conversation-message-state/);
    assert.match(item, /data-conversation-message-toggle/);
    assert.match(item, /!expanded && summary/);
    assert.match(item, /expanded && <MessageActionBar/);
    assert.match(item, /expanded && <div data-conversation-message-expanded-content/);
    assert.match(item, /copy\.listUnsubscribe/);
    assert.match(item, /<AttachmentList attachments=\{attachments\}/);
    assert.match(presentation, /if \(!normalized\) return null/);
  });
});
