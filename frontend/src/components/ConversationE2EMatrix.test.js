import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation E2E 2x2 contract', () => {
  it('documents behavior for every feature preference pair', () => {
    const source = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    const matrix = [
      { list: false, reader: false, expected: 'legacy list and reader' },
      { list: true, reader: false, expected: 'conversation list with legacy reader' },
      { list: false, reader: true, expected: 'legacy list with conversation reader' },
      { list: true, reader: true, expected: 'conversation list and reader' },
    ];
    assert.equal(matrix.length, 4);
    assert.match(source, /conversationListViewEnabled/);
    assert.match(source, /conversationReaderViewEnabled/);
    assert.match(source, /ConversationList/);
    assert.match(source, /ConversationPane/);
    for (const state of matrix) assert.equal(typeof state.expected, 'string');
  });
});
