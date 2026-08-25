import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
describe('Conversation settings contract', () => {
  it('uses the native grouping preference and reader descriptions', () => {
    const source = readFileSync(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');
    assert.match(source, /conversation\.groupIntoConversations/);
    assert.match(source, /setThreadedView/);
    assert.match(source, /conversation\.readerOffDesc/);
    assert.match(source, /conversation\.readerOnDesc/);
    assert.doesNotMatch(source, /conversation_list_view_enabled/);
  });
});
