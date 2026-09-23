import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationDetailToThreadMessages, nativeThreadToReaderMessages } from './conversationThreadAdapter.ts';

test('nativeThreadToReaderMessages ignores entries without a physical copy id', () => {
  const messages = nativeThreadToReaderMessages([
    { message_id: '<logical-only@example.test>', subject: 'invalid native record' },
    { id: 'physical-copy-1', message_id: '<valid@example.test>', subject: 'valid native record' },
  ], 'account-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].copies[0].id, 'physical-copy-1');
});

test('nativeThreadToReaderMessages preserves the physical reply chain', () => {
  const messages = nativeThreadToReaderMessages([
    { id: 'copy-c', message_id: '<c@example.test>', in_reply_to: '<b@example.test>', thread_references: '<a@example.test> <b@example.test>' },
  ], 'account-1');
  const copy = messages[0].copies[0];
  assert.equal(copy.in_reply_to, '<b@example.test>');
  assert.equal(copy.inReplyTo, '<b@example.test>');
  assert.equal(copy.thread_references, '<a@example.test> <b@example.test>');
  assert.equal(copy.references, '<a@example.test> <b@example.test>');
});

test('conversation detail copies preserve the reply chain for Reply intent', () => {
  const messages = conversationDetailToThreadMessages({
    summary: { id: 'conversation-1', account_id: 'account-1' },
    logicalMessages: [{
      id: 'logical-c',
      canonicalMessageId: '<c@example.test>',
      copies: [{ id: 'copy-c', account_id: 'account-1', folder: 'INBOX', message_id: '<c@example.test>', in_reply_to: '<b@example.test>', thread_references: '<a@example.test> <b@example.test>' }],
    }],
  }, 'INBOX');
  const copy = messages[0];
  assert.ok(copy, 'expected the preferred physical conversation copy');
  assert.equal(copy.inReplyTo, '<b@example.test>');
  assert.equal(copy.references, '<a@example.test> <b@example.test>');
});

test('nativeThreadToReaderMessages treats malformed payloads as unavailable', () => {
  assert.deepEqual(nativeThreadToReaderMessages({ messages: [] }, 'account-1'), []);
  assert.deepEqual(nativeThreadToReaderMessages([null, undefined, {}], 'account-1'), []);
});
