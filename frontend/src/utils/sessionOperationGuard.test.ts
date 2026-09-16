import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionOperationGuard } from './sessionOperationGuard.ts';

test('rejects a late draft open after authentication changes', () => {
  let epoch = 1;
  const guard = createSessionOperationGuard(() => epoch);
  const isCurrent = guard.begin();
  epoch = 2;
  assert.equal(isCurrent(), false);
});

test('rejects a late draft open after it is superseded or unmounted', () => {
  let epoch = 1;
  const guard = createSessionOperationGuard(() => epoch);
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  guard.invalidate();
  assert.equal(second(), false);
});

test('accepts the current draft open in the same session', () => {
  const guard = createSessionOperationGuard(() => 1);
  assert.equal(guard.begin()(), true);
});
