import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('DAV Hub API client', () => {
  it('uses authenticated, CSRF-aware routes for revocable DAV application passwords', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await api.davCredentials.list();
    await api.davCredentials.create('DAVx5 phone');
    await api.davCredentials.revoke('credential-1');

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/dav-credentials', 'GET'],
      ['/api/dav-credentials', 'POST'],
      ['/api/dav-credentials/credential-1', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[1][1].body, JSON.stringify({ label: 'DAVx5 phone' }));
  });

  it('uses the calendar API contract for local event CRUD and range reads', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('no content'); } };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const event = { calendarId: 'calendar-1', summary: 'Planning' };

    await api.calendar.listCalendars();
    await api.calendar.listEvents('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    await api.calendar.createEvent(event);
    await api.calendar.updateEvent('event-1', event);
    assert.equal(await api.calendar.deleteEvent('event-1', 'calendar-1'), null);

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/calendar/calendars', 'GET'],
      ['/api/calendar/events?from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z', 'GET'],
      ['/api/calendar/events', 'POST'],
      ['/api/calendar/events/event-1', 'PATCH'],
      ['/api/calendar/events/event-1?calendarId=calendar-1', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[2][1].body, JSON.stringify(event));
    assert.equal(calls[3][1].body, JSON.stringify(event));
  });
});
