import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginMutation,
  invalidateMutation,
  isLatestMutation,
  resetMutationIntentsForTest,
} from './mutationIntent.js';

test.beforeEach(() => resetMutationIntentsForTest());

test('a delayed failure cannot restore state after a newer mutation intent', async () => {
  const key = 'account-1:thread-1';
  const first = beginMutation(key);
  const state = { visible: false };

  const deferred = new Promise(resolve => setTimeout(resolve, 0));
  const second = beginMutation(key);
  state.visible = true;
  await deferred;

  if (isLatestMutation(key, first)) state.visible = true;
  assert.equal(isLatestMutation(key, first), false);
  assert.equal(isLatestMutation(key, second), true);
  assert.equal(state.visible, true);
});

test('undo invalidates a pending move before its delayed request settles', () => {
  const key = 'account-1:thread-1';
  const version = beginMutation(key);
  invalidateMutation(key);
  assert.equal(isLatestMutation(key, version), false);
});
