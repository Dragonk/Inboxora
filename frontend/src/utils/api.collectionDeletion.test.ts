import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { api, CSRF_HEADER, CSRF_VALUE, normalizeCollectionDeletionResponse } from './api.ts';

afterEach(() => mock.restoreAll());

test('collection deletion calls the dedicated DELETE routes with confirmation, stable identity and CSRF', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ state: 'outcome_unknown' }) };
  });
  const body = { confirmName: 'Shared projects', idempotencyKey: 'original-key' };
  assert.deepEqual(await api.addressBooks.remove('book/id', body), { state: 'outcome_unknown' });
  await api.deleteAccountProviderCalendar('account/id', 'collection/id', body);
  assert.deepEqual(await api.calendar.deleteCalendar('dav/id', body), { state: 'outcome_unknown' });
  assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
    ['/api/contacts/address-books/book%2Fid', 'DELETE'],
    ['/api/accounts/account%2Fid/provider-calendars/collection%2Fid', 'DELETE'],
    ['/api/calendar/calendars/dav%2Fid', 'DELETE'],
  ]);
  for (const { init } of calls) {
    assert.equal(init.body, JSON.stringify(body));
    assert.equal(new Headers(init.headers).get(CSRF_HEADER), CSRF_VALUE);
  }
});


test('ordinary lists avoid provider capability reads; management explicitly opts in', async () => {
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url); return { ok: true, status: 200, json: async () => ({}) };
  });
  await api.addressBooks.list();
  await api.calendar.listCalendars();
  await api.addressBooks.list({ includeDeletionCapabilities: true });
  await api.calendar.listCalendars({ includeDeletionCapabilities: true });
  assert.deepEqual(calls, [
    '/api/contacts/address-books', '/api/calendar/calendars',
    '/api/contacts/address-books?includeDeletionCapabilities=true',
    '/api/calendar/calendars?includeDeletionCapabilities=true',
  ]);
});

test('only explicit confirmed results confirm remote collections; local 204 retains its empty response', async () => {
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 204 }));
  const confirmation = { confirmName: 'DAV projects', idempotencyKey: 'same-intent' };
  assert.equal(await api.calendar.deleteCalendar('local', 'Local'), null);
  assert.equal(await api.addressBooks.remove('local'), null);
  assert.deepEqual(await api.calendar.deleteCalendar('dav', confirmation), { state: 'outcome_unknown' });
  assert.deepEqual(await api.addressBooks.remove('dav', confirmation), { state: 'outcome_unknown' });
  for (const value of [null, undefined, {}, { success: true }, { state: 'deleted' }, { state: 1 }]) {
    assert.deepEqual(normalizeCollectionDeletionResponse(value), { state: 'outcome_unknown' });
  }
  assert.deepEqual(normalizeCollectionDeletionResponse({ state: 'confirmed', operationId: 'journal-id' }), { state: 'confirmed', operationId: 'journal-id' });
});

test('DAV refusal stays an error and unresolved 202 remains unknown', async () => {
  const confirmation = { confirmName: 'DAV projects', idempotencyKey: 'same-intent' };
  mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403, json: async () => ({ state: 'failed', error: 'Collection is read-only', code: 'DAV_COLLECTION_REFUSED' }) }));
  await assert.rejects(api.calendar.deleteCalendar('dav', confirmation), /Collection is read-only/);
  await assert.rejects(api.addressBooks.remove('dav', confirmation), /Collection is read-only/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 202, json: async () => ({ state: 'outcome_unknown', operationId: 'pending-journal' }) }));
  assert.deepEqual(await api.calendar.deleteCalendar('dav', confirmation), { state: 'outcome_unknown', operationId: 'pending-journal' });
  assert.deepEqual(await api.addressBooks.remove('dav', confirmation), { state: 'outcome_unknown', operationId: 'pending-journal' });
});
