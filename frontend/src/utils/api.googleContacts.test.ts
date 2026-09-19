import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.ts';

/** The init object `request()` builds always carries a plain headers record. */
type RecordedInit = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };
type RecordedCall = [url: string, init: RecordedInit];

afterEach(() => {
  mock.restoreAll();
});

describe('Google contacts API client', () => {
  it('reads the status and triggers the sync through their routes', async () => {
    const calls: RecordedCall[] = [];
    const fetchStub = async (url: string, init: RecordedInit) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);

    await api.googleContacts.status();
    await api.googleContacts.sync();

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/contacts/providers/google/status', 'GET'],
      ['/api/contacts/providers/google/sync', 'POST'],
    ]);
    // The mutating call must carry the CSRF header like every other request.
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
  });

  it('reads the calendar status and triggers the calendar sync through their routes', async () => {
    const calls: RecordedCall[] = [];
    const fetchStub = async (url: string, init: RecordedInit) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);

    await api.calendar.googleCalendars.status();
    await api.calendar.googleCalendars.sync();

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/calendar/providers/google/status', 'GET'],
      ['/api/calendar/providers/google/sync', 'POST'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
  });
});
