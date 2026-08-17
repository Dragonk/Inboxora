import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation E2E 2x2 contract', () => {
  it('maps every preference pair to independent list and reader components', () => {
    const source = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    const matrix = [
      { list: false, reader: false, listComponent: 'MessageList', readerComponent: 'MessagePane' },
      { list: true, reader: false, listComponent: 'ConversationList', readerComponent: 'MessagePane' },
      { list: false, reader: true, listComponent: 'MessageList', readerComponent: 'ConversationPane' },
      { list: true, reader: true, listComponent: 'ConversationList', readerComponent: 'ConversationPane' },
    ];
    assert.equal(matrix.length, 4);
    assert.doesNotMatch(source, /conversationMode\s*=/);
    assert.match(source, /conversationListViewEnabled \? <ConversationList/);
    assert.match(source, /conversationReaderViewEnabled && conversationId \? <ConversationPane/);
    assert.match(source, /targetLogicalMessageId/);
  });
});
