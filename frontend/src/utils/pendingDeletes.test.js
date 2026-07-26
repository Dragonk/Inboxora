import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeleteGuard,
  clearDeleteGuard,
  clearPendingDelete,
  setCompletedDelete,
  setPendingDelete,
  pendingDeleteMap,
  completedDeleteMap,
} from './pendingDeletes.js';

// The guard is what stops a background refresh / websocket refetch from resurrecting a
// row that was optimistically removed (archive/delete) but whose server-side removal is
// not yet committed. Bulk archive and delete both feed it via setPendingDelete /
// setCompletedDelete / clearDeleteGuard; the three list-refetch paths run results through
// applyDeleteGuard. These tests cover that reconciliation.
describe('pendingDeletes guard', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const guarded = () => applyDeleteGuard(list).map(m => m.id);

  // Clear timers/state so tests don't leak into each other or keep the process alive.
  afterEach(() => ['a', 'b', 'c'].forEach(clearDeleteGuard));

  it('returns the input untouched when nothing is guarded', () => {
    assert.equal(applyDeleteGuard(list), list);
  });

  it('hides a pending id from refetch results, and restores it on clear', () => {
    setPendingDelete('b');
    assert.deepEqual(guarded(), ['a', 'c']);
    clearPendingDelete('b');
    assert.deepEqual(guarded(), ['a', 'b', 'c']);
  });

  it('keeps hiding a committed (completed) id during its grace window', () => {
    setPendingDelete('a');
    setCompletedDelete('a'); // pending -> completed grace
    assert.ok(!pendingDeleteMap.has('a'));
    assert.ok(completedDeleteMap.has('a'));
    assert.deepEqual(guarded(), ['b', 'c']);
  });

  it('filters multiple guarded ids at once (pending + completed)', () => {
    setPendingDelete('a');
    setCompletedDelete('c');
    assert.deepEqual(guarded(), ['b']);
  });

  it('clearDeleteGuard releases an id from both pending and completed', () => {
    setPendingDelete('a');
    setCompletedDelete('a');
    clearDeleteGuard('a');
    assert.ok(!pendingDeleteMap.has('a') && !completedDeleteMap.has('a'));
    assert.deepEqual(guarded(), ['a', 'b', 'c']);
  });
});
