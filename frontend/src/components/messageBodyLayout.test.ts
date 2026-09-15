import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleInitialLayoutReady } from './messageBodyLayout.ts';

interface RafHarness {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  runNext(): boolean;
  pending(): number;
  runCancelled(): void;
  cancelled: number[];
}

function rafHarness(): RafHarness {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelledCallbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      cancelled.push(id);
      const callback = callbacks.get(id);
      if (callback !== undefined) cancelledCallbacks.set(id, callback);
      callbacks.delete(id);
    },
    runNext() {
      const next = callbacks.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback(0);
      return true;
    },
    pending: () => callbacks.size,
    runCancelled() {
      for (const callback of cancelledCallbacks.values()) callback(0);
      cancelledCallbacks.clear();
    },
    cancelled,
  };
}

describe('initial message body layout scheduling', () => {
  it('cancels the nested paint callback when the renderer unmounts after the outer paint', () => {
    const harness = rafHarness();
    const ready: unknown[] = [];
    const cancel = scheduleInitialLayoutReady(
      height => { ready.push(height); },
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
    const ready: unknown[] = [];
    const cancel = scheduleInitialLayoutReady(
      height => { ready.push(height); },
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
