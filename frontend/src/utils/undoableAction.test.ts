import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as undoableAction from './undoableAction.ts';

function fakeTimer() {
  let callback: (() => void | Promise<void>) | undefined;
  let cancelled = false;
  return {
    schedule(fn: () => void | Promise<void>): string {
      callback = fn;
      return 'timer';
    },
    cancel(timer: unknown): void {
      assert.equal(timer, 'timer');
      cancelled = true;
    },
    async fire(): Promise<void> {
      if (callback === undefined) {
        throw new Error('Timer callback has not been scheduled');
      }
      await callback();
    },
    wasCancelled() {
      return cancelled;
    },
  };
}

describe('createUndoableCommit', () => {
  it('cancels a pending commit and runs undo exactly once', async () => {
    assert.equal(typeof undoableAction.createUndoableCommit, 'function');
    const timer = fakeTimer();
    const calls: unknown[] = [];
    const action = undoableAction.createUndoableCommit({
      delayMs: 4500,
      commit: async () => { calls.push('commit'); },
      undo: () => { calls.push('undo'); },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    assert.equal(action.undo(), true);
    assert.equal(action.undo(), false);
    await timer.fire();

    assert.equal(timer.wasCancelled(), true);
    assert.deepEqual(calls, ['undo']);
  });

  it('rejects a late undo after the commit has started', async () => {
    assert.equal(typeof undoableAction.createUndoableCommit, 'function');
    const timer = fakeTimer();
    const calls: unknown[] = [];
    const action = undoableAction.createUndoableCommit({
      delayMs: 4500,
      commit: async () => { calls.push('commit'); },
      undo: () => { calls.push('undo'); },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    await timer.fire();
    assert.equal(action.undo(), false);

    assert.equal(timer.wasCancelled(), false);
    assert.deepEqual(calls, ['commit']);
  });

  it('can undo while an opted-in commit is awaiting asynchronous work', async () => {
    const timer = fakeTimer();
    const calls: unknown[] = [];
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const action = undoableAction.createUndoableCommit({
      allowUndoWhileCommitting: true,
      commit: async () => { calls.push('commit'); await pending; },
      undo: () => { calls.push('undo'); },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    const firing = timer.fire();
    await Promise.resolve();
    assert.equal(action.undo(), true);
    if (release === undefined) throw new Error('Pending commit resolver has not been installed');
    release();
    await firing;
    assert.deepEqual(calls, ['commit', 'undo']);
  });
});
