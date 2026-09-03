import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleInitialLayoutReady } from './messageBodyLayout.js';

function rafHarness() {
  let nextId = 1;
  const callbacks = new Map();
  const cancelledCallbacks = new Map();
  const cancelled = [];
  return {
    requestAnimationFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
      if (callbacks.has(id)) cancelledCallbacks.set(id, callbacks.get(id));
      callbacks.delete(id);
    },
    runNext() {
      const next = callbacks.entries().next().value;
      if (!next) return false;
      callbacks.delete(next[0]);
      next[1]();
      return true;
    },
    pending: () => callbacks.size,
    runCancelled() {
      for (const callback of cancelledCallbacks.values()) callback();
      cancelledCallbacks.clear();
    },
    cancelled,
  };
}

describe('initial message body layout scheduling', () => {
  it('cancels the nested paint callback when the renderer unmounts after the outer paint', () => {
    const harness = rafHarness();
    const ready = [];
    const cancel = scheduleInitialLayoutReady(
      height => ready.push(height),
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );

    assert.equal(harness.pending(), 1);
    harness.runNext();
    assert.equal(harness.pending(), 1);

    cancel();
    assert.equal(harness.pending(), 0);
    harness.runCancelled();
    assert.equal(ready.length, 0);
    assert.equal(harness.cancelled.length, 1);
  });

  it('cancels a superseded nested paint callback before a replacement is scheduled', () => {
    const harness = rafHarness();
    const ready = [];
    const cancel = scheduleInitialLayoutReady(
      height => ready.push(height),
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );

    harness.runNext();
    cancel();
    assert.equal(harness.pending(), 0);
    harness.runCancelled();
    assert.equal(ready.length, 0);

    scheduleInitialLayoutReady(
      () => ready.push('replacement'),
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );
    harness.runNext();
    harness.runNext();
    assert.deepEqual(ready, ['replacement']);
  });
});
