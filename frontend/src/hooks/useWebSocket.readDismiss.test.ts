import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./useWebSocket.ts', import.meta.url), 'utf8');

describe('WebSocket native read-dismissal contract', () => {
  it('forwards ids of messages read on any device to the native canceller', () => {
    assert.match(source, /const readIds: string\[\] = \[\];/);
    assert.match(source, /if \(c\.is_read === true\) readIds\.push\(c\.id\);/);
    assert.match(source, /if \(readIds\.length\) \{[\s\S]*?window\.inboxoraNative\?\.notifications\?\.cancelMessageNotifications\?\.\(readIds\);[\s\S]*?\}/);
  });
});

