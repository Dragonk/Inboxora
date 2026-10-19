import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.ts';

/** The init object `request()` builds always carries a plain headers record. */
type RecordedInit = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };
/** One recorded fetch() call: [url, init]. */
type RecordedCall = [url: string, init: RecordedInit];

afterEach(() => {
  mock.restoreAll();
});

describe('calendar reminder API client', () => {
  it('targets the reminder cascade endpoints with the expected methods and bodies', async () => {
    const calls: RecordedCall[] = [];
    const fetchStub = async (url: string, init: RecordedInit) => {
      calls.push([url, init]);
      if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('no content'); } };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    mock.method(globalThis, 'fetch', fetchStub);

    await api.calendar.getReminderSettings();
    await api.calendar.updateReminderSettings({ enabled: true, minutes: 30, mode: 'notification' });
    await api.calendar.getReminderPreview(48);
    await api.calendar.getEventReminder('event-1');
    await api.calendar.setEventReminder('event-1', { enabled: true, minutesBefore: 15, mode: 'alarm' });
    assert.equal(await api.calendar.clearEventReminder('event-1'), null);

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/calendar/reminder-settings', 'GET'],
      ['/api/calendar/reminder-settings', 'PUT'],
      ['/api/calendar/reminder-preview?hours=48', 'GET'],
      ['/api/calendar/events/event-1/reminder', 'GET'],
      ['/api/calendar/events/event-1/reminder', 'PUT'],
      ['/api/calendar/events/event-1/reminder', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[1][1].body, JSON.stringify({ enabled: true, minutes: 30, mode: 'notification' }));
    assert.equal(calls[4][1].body, JSON.stringify({ enabled: true, minutesBefore: 15, mode: 'alarm' }));
  });

  it('encodes event ids and reminder windows in reminder URLs', async () => {
    const calls: RecordedCall[] = [];
    const fetchStub = async (url: string, init: RecordedInit) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
    mock.method(globalThis, 'fetch', fetchStub);

    await api.calendar.getEventReminder('event/with spaces');
    await api.calendar.getReminderPreview(72);

    assert.equal(calls[0][0], '/api/calendar/events/event%2Fwith%20spaces/reminder');
    assert.equal(calls[1][0], '/api/calendar/reminder-preview?hours=72');
  });
});

