import assert from 'node:assert/strict';
import test from 'node:test';
import { isDraftSnapshotCurrent } from './draftSaveAcknowledgement.ts';

test('accepts an unchanged draft snapshot exactly at its captured revision', () => {
  assert.equal(isDraftSnapshotCurrent(7, 7), true);
});

test('does not promote a recipient from a stale save acknowledgement (V6-03)', () => {
  assert.equal(isDraftSnapshotCurrent(7, 8), false);
});

test('does not close a composer when save-and-close becomes stale (V6-04)', () => {
  assert.equal(isDraftSnapshotCurrent(11, 12), false);
});
