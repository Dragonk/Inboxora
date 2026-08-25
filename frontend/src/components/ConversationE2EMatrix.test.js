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
    assert.match(list, /const direction = isOutgoing \? '→' : '←'/);
    assert.match(list, /ownAddresses=\{new Set\(accounts\.map/);
  });
  it('resolves every selected physical copy through the CE identity endpoint (OFF/ON blocker)', () => {
    const app = read('MailApp.jsx');
    assert.match(app, /conversationApi\.resolveMessage\(selectedMessageId\)/);
    assert.match(app, /setConversationId\(resolved\.conversation_id\)/);
    assert.match(app, /setTargetLogicalMessageId\(resolved\.logical_message_id/);
    assert.match(app, /data-ce-resolution-error/);
    assert.match(app, /Conversation reader resolution failed/);
  });
  it('uses compact native-pane message cards and per-message reply targets', () => {
    const reader = read('ConversationReader.jsx'); const item = read('ConversationMessage.jsx');
    assert.match(reader, /new Set\(\[targetLogicalMessageId \|\| newest\]\.filter\(Boolean\)\)/);
    assert.match(item, /MessageActionBar/);
    const presentation = read('MessagePresentation.jsx');
    assert.match(presentation, /data-conversation-message-actions/);
    assert.match(item, /logicalMessageId: message\.id/);
    assert.match(item, /MessageBodyRenderer/);
    assert.match(item, /data-conversation-message-state/);
    assert.doesNotMatch(item, /boxShadow|borderRadius: 10|marginBottom: 24/);
  });
});
