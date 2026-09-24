import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfirmedNativeCalendarOperation, nativeCalendarDeleteAllowed, nativeCalendarOperationBlocksRetry } from './calendarCollectionManagementModel.ts';

test('only a server-confirmed native lifecycle response refreshes projections', () => {
  assert.equal(isConfirmedNativeCalendarOperation({ state: 'confirmed', collectionId: 'collection' }), true);
  for (const state of ['pending', 'retryable', 'outcome_unknown', 'conflict', 'failed'] as const) assert.equal(isConfirmedNativeCalendarOperation({ state }), false);
});
test('durable nonterminal states block blind lifecycle retries', () => {
  for (const state of ['pending', 'retryable', 'outcome_unknown', 'conflict'] as const) assert.equal(nativeCalendarOperationBlocksRetry({ state }), true);
  assert.equal(nativeCalendarOperationBlocksRetry({ state: 'confirmed' }), false);
  assert.equal(nativeCalendarOperationBlocksRetry({ state: 'failed' }), false);
});
test('only linked native provider collections offer server-guarded deletion confirmation', () => {
  assert.equal(nativeCalendarDeleteAllowed({ source: 'google', collection_id: 'collection' }), true);
  assert.equal(nativeCalendarDeleteAllowed({ source: 'microsoft', collection_id: 'collection' }), true);
  assert.equal(nativeCalendarDeleteAllowed({ source: 'local', collection_id: 'collection' }), false);
  assert.equal(nativeCalendarDeleteAllowed({ source: 'google', collection_id: null }), false);
});
