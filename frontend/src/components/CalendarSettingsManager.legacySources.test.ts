import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarSourceRemoval, confirmCalendarSourceRemoval } from './accountUi/sourceRemoval.ts';

test('calendar settings exposes legacy cleanup only for orphaned CalDAV and ICS collections', () => {
  for (const kind of ['caldav', 'ical_url']) {
    const connection = { id: `collection:${kind}-legacy`, kind };
    assert.deepEqual(calendarSourceRemoval(connection), { kind: 'legacy', id: connection.id });
    assert.equal(calendarSourceRemoval({ ...connection, accountId: 'account-1' }), null);
    assert.equal(calendarSourceRemoval({ ...connection, id: 'calendar-source:missing' }), null);
    assert.deepEqual(calendarSourceRemoval(connection, { id: 'current-1' }), { kind: 'current', id: 'current-1' });
  }
  for (const kind of ['google', 'microsoft', 'local', 'system', 'carddav']) {
    assert.equal(calendarSourceRemoval({ id: `collection:${kind}-legacy`, kind }), null);
  }
});

test('confirming legacy cleanup forgets the selected source ID without deleting a current source', async () => {
  for (const kind of ['caldav', 'ical_url']) {
    const calls: string[] = [];
    const api = { calendar: {
      forgetLegacySource: async (id: string) => { calls.push(`forget:${id}`); },
      deleteSource: async (id: string) => { calls.push(`delete:${id}`); },
    } };
    const connection = { id: `collection:${kind}-legacy`, kind };
    const removal = calendarSourceRemoval(connection);
    assert.ok(removal);
    assert.deepEqual(calls, []);
    await confirmCalendarSourceRemoval(api.calendar, removal);
    assert.deepEqual(calls, [`forget:${connection.id}`]);
  }
});

test('current calendar sources continue using the normal disconnect path', async () => {
  for (const kind of ['caldav', 'ical_url']) {
    const calls: string[] = [];
    const api = { calendar: {
      forgetLegacySource: async (id: string) => { calls.push(`forget:${id}`); },
      deleteSource: async (id: string) => { calls.push(`delete:${id}`); },
    } };
    const removal = calendarSourceRemoval({ id: 'calendar-source:current-1', kind }, { id: 'current-1' });
    assert.deepEqual(removal, { kind: 'current', id: 'current-1' });
    assert.ok(removal);
    assert.deepEqual(calls, []);
    await confirmCalendarSourceRemoval(api.calendar, removal);
    assert.deepEqual(calls, ['delete:current-1']);
  }
});
