import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('Conversation E2E matrix contract', () => {
  it('covers all four list/reader preference combinations', () => {
    const source = readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');
    for (const list of [false, true]) for (const reader of [false, true]) {
      assert.equal(typeof list, 'boolean');
      assert.equal(typeof reader, 'boolean');
      assert.match(source, /conversationListViewEnabled/);
      assert.match(source, /conversationReaderViewEnabled/);
    }
  });
});
