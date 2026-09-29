import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfirmedNativeCalendarOperation, providerCalendarDeleteAllowed, nativeCalendarOperationBlocksRetry } from './calendarCollectionManagementModel.ts';

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
  assert.equal(providerCalendarDeleteAllowed({ source: 'google', collection_id: 'collection', deletion: { supported: true } }), true);
  assert.equal(providerCalendarDeleteAllowed({ source: 'microsoft', collection_id: 'collection', deletion: { supported: true } }), true);
  assert.equal(providerCalendarDeleteAllowed({ source: 'google', collection_id: 'collection' }), false);
  assert.equal(providerCalendarDeleteAllowed({ source: 'microsoft', collection_id: 'collection', deletion: { supported: false, reason: 'Default calendar' } }), false);
  assert.equal(providerCalendarDeleteAllowed({ source: 'local', collection_id: 'collection' }), false);
  assert.equal(providerCalendarDeleteAllowed({ source: 'google', collection_id: null }), false);
});

test('CalDAV deletion requires a local collection identity and explicit server capability', () => {
  assert.equal(providerCalendarDeleteAllowed({ source: 'caldav', id: 'calendar', deletion: { supported: true } }), true);
  for (const input of [
    { source: 'caldav', id: 'calendar' },
    { source: 'caldav', collection_id: 'unrelated', deletion: { supported: true } },
    { source: 'caldav', id: 'calendar', deletion: { supported: false } },
    { source: 'ical', id: 'calendar', deletion: { supported: true } },
    { source: 'local', id: 'calendar', deletion: { supported: true } },
  ]) assert.equal(providerCalendarDeleteAllowed(input), false);
});
