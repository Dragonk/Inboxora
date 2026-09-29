import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionDeletionAllowed, readCollectionDeleteIntents, sendCollectionDeletion, type CollectionDeleteIntent } from './collectionDeletionModel.ts';

const intent: CollectionDeleteIntent = { id: 'book', name: 'Work', idempotencyKey: 'stable-key', response: { state: 'pending' } };

test('provider deletion is opt-in and cannot be inferred from source write access', () => {
  assert.equal(collectionDeletionAllowed(), false);
  assert.equal(collectionDeletionAllowed({ supported: false, reason: 'Default folder' }), false);
  assert.equal(collectionDeletionAllowed({ supported: true }), true);
});

test('restoring a request preserves its identity and treats its outcome as unknown', () => {
  const restored = readCollectionDeleteIntents(JSON.stringify({ book: intent }));
  assert.equal(restored.book.idempotencyKey, intent.idempotencyKey);
  assert.equal(restored.book.response.state, 'outcome_unknown');
  assert.throws(() => readCollectionDeleteIntents('{'));
  assert.throws(() => readCollectionDeleteIntents(JSON.stringify({ book: { ...intent, id: 'other-book' } })));
});

test('unknown or unstructured responses retain intent; checking uses the same request identity', async () => {
  for (const response of [{ state: 'outcome_unknown' }, { state: 'pending' }, { state: 'failed' }, {}, null]) {
    const stored: CollectionDeleteIntent[] = []; const calls: string[] = []; let confirmed = false;
    const options = { current: () => true, persist: (next: CollectionDeleteIntent) => stored.push(next), send: async (next: CollectionDeleteIntent) => { calls.push(next.idempotencyKey); return response; }, confirmed: () => { confirmed = true; } };
    assert.equal(await sendCollectionDeletion(intent, options), false);
    assert.equal(confirmed, false);
    assert.equal(stored[0], intent);
    assert.equal(await sendCollectionDeletion(stored.at(-1)!, options), false);
    assert.deepEqual(calls, ['stable-key', 'stable-key']);
  }
});

test('confirmation releases intent only while its starting session is still active', async () => {
  let active = true; let confirmed = false;
  assert.equal(await sendCollectionDeletion(intent, { current: () => active, persist: () => {}, send: async () => { active = false; return { state: 'confirmed' }; }, confirmed: () => { confirmed = true; } }), false);
  assert.equal(confirmed, false);
  assert.equal(await sendCollectionDeletion(intent, { current: () => true, persist: () => {}, send: async () => ({ state: 'confirmed' }), confirmed: () => { confirmed = true; } }), true);
  assert.equal(confirmed, true);
});

test('network errors preserve unknown intent and storage failures prevent dispatch', async () => {
  const stored: CollectionDeleteIntent[] = [];
  await assert.rejects(sendCollectionDeletion(intent, { current: () => true, persist: next => { stored.push(next); }, send: async () => { throw new Error('Disconnected'); }, confirmed: () => assert.fail('Must retain projection') }), /Disconnected/);
  assert.equal(stored.at(-1)?.response.state, 'outcome_unknown');
  let sent = false;
  await assert.rejects(sendCollectionDeletion(intent, { current: () => true, persist: () => { throw new Error('Storage unavailable'); }, send: async () => { sent = true; return { state: 'confirmed' }; }, confirmed: () => {} }), /Storage unavailable/);
  assert.equal(sent, false);
});
