import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRowGestureSuppressed,
  isVisualViewportZoomed,
  resetGestureArbitration,
  setRowGestureSuppressed,
  setVisualViewportZoomed,
} from './mobileGestureArbiter.ts';

describe('mobile gesture arbiter', () => {
  beforeEach(() => resetGestureArbitration());

  it('starts unsuppressed so rows behave normally', () => {
    assert.equal(isRowGestureSuppressed(), false);
  });

  it('holds suppression for the remainder of the sequence', () => {
    setRowGestureSuppressed(true);
    assert.equal(isRowGestureSuppressed(), true);
    // The drawer does not release at its own touchend; the row's touchend reads
    // the flag afterwards, so suppression must survive until the next start.
    assert.equal(isRowGestureSuppressed(), true);
  });

  it('releases suppression when the row finishes its suppressed sequence', () => {
    setRowGestureSuppressed(true);
    setRowGestureSuppressed(false);
    assert.equal(isRowGestureSuppressed(), false);
  });

  it('resets defensively on teardown', () => {
    setRowGestureSuppressed(true);
    resetGestureArbitration();
    assert.equal(isRowGestureSuppressed(), false);
  });
});

describe('visual viewport zoom state', () => {
  beforeEach(() => {
    resetGestureArbitration();
    setVisualViewportZoomed(false);
  });

  it('starts unzoomed so horizontal gestures behave normally', () => {
    assert.equal(isVisualViewportZoomed(), false);
  });

  it('marks the zoomed viewport as the owner of every drag', () => {
    setVisualViewportZoomed(true);
    assert.equal(isVisualViewportZoomed(), true);
  });

  it('is independent of row suppression state', () => {
    setRowGestureSuppressed(true);
    setVisualViewportZoomed(true);
    assert.equal(isVisualViewportZoomed(), true);
    setVisualViewportZoomed(false);
    assert.equal(isRowGestureSuppressed(), true);
  });
});
