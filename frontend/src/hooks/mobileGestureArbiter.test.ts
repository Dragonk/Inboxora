import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRowGestureSuppressed,
  resetGestureArbitration,
  setRowGestureSuppressed,
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
