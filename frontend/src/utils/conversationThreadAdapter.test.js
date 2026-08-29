import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeThreadToReaderMessages } from './conversationThreadAdapter.js';

test('nativeThreadToReaderMessages ignores entries without a physical copy id', () => {
  const messages = nativeThreadToReaderMessages([
    { message_id: '<logical-only@example.test>', subject: 'invalid native record' },
    { id: 'physical-copy-1', message_id: '<valid@example.test>', subject: 'valid native record' },
  ], 'account-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].copies[0].id, 'physical-copy-1');
});

test('nativeThreadToReaderMessages treats malformed payloads as unavailable', () => {
  assert.deepEqual(nativeThreadToReaderMessages({ messages: [] }, 'account-1'), []);
  assert.deepEqual(nativeThreadToReaderMessages([null, undefined, {}], 'account-1'), []);
});
