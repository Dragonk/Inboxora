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
    { id: 'copy-c', category: 'social', folder_paths: ['INBOX'], is_archived: false, message_id: '<c@example.test>', in_reply_to: '<b@example.test>', thread_references: '<a@example.test> <b@example.test>' },
  ], 'account-1');
  const copy = messages[0].copies[0];
  assert.equal(copy.category, 'social');
  assert.deepEqual(copy.folder_paths, ['INBOX']);
  assert.equal(copy.is_archived, false);
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

test('physical copies with identical RFC IDs remain separate reader cards and action targets', async () => {
  const { mergeThreadWithConversation } = await import('./conversationThreadAdapter.ts');
  const native = nativeThreadToReaderMessages([
    { id: 'read-copy', account_id: 'a', message_id: '<same>', is_read: true },
    { id: 'unread-copy', account_id: 'a', message_id: '<same>', is_read: false },
  ], 'a');
  const detail = { summary: { id: 'thread', account_id: 'a' }, logicalMessages: [{ id: 'logical', copies: [
    { id: 'read-copy', account_id: 'a', message_id: '<same>', is_read: true },
    { id: 'unread-copy', account_id: 'a', message_id: '<same>', is_read: false },
    { id: 'foreign', account_id: 'b', message_id: '<same>', is_read: false },
  ] }] };
  const merged = mergeThreadWithConversation(detail.logicalMessages, native);
  assert.deepEqual(merged.map(row => row.id), ['read-copy', 'unread-copy']);
  assert.deepEqual(merged.map(row => row.copies?.map(copy => copy.id)), [['read-copy'], ['unread-copy']]);
  assert.deepEqual(merged.map(row => row.logicalMessageId), ['logical', 'logical']);
  assert.deepEqual(conversationDetailToThreadMessages(detail, 'INBOX').map(row => row.id), ['read-copy', 'unread-copy']);
});

test('selecting an unread physical duplicate does not open its read logical sibling', async () => {
  const { mergeThreadWithConversation, conversationTargetId } = await import('./conversationThreadAdapter.ts');
  const native = nativeThreadToReaderMessages([
    { id: 'read-copy', account_id: 'a', message_id: '<same>', is_read: true },
    { id: 'unread-copy', account_id: 'a', message_id: '<same>', is_read: false },
  ], 'a');
  const merged = mergeThreadWithConversation([{ id: 'logical', unread: false, copies: [
    { id: 'read-copy', account_id: 'a', message_id: '<same>', is_read: true },
    { id: 'unread-copy', account_id: 'a', message_id: '<same>', is_read: true },
  ] }], native);
  assert.equal(conversationTargetId(merged, 'logical', 'unread-copy'), 'unread-copy');
  assert.equal(conversationTargetId(merged, 'logical', 'read-copy'), 'read-copy');
  assert.equal(conversationTargetId(merged, 'logical', null), undefined);
  assert.equal(conversationTargetId(merged, 'missing-logical', 'unread-copy'), 'unread-copy');
  assert.equal(merged[1].unread, true, 'native read evidence overrides stale logical metadata');
});
