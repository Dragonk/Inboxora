import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eventPayload, eventsForDay, monthRange, shiftCalendarAnchor, toggleAllDayTimes, weekRange } from './calendarView.js';

describe('calendar desktop helpers', () => {
  it('returns an exclusive month range', () => {
    const { start, end } = monthRange(new Date(2026, 8, 14));
    assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate()], [2026, 8, 1]);
    assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate()], [2026, 9, 1]);
  });
  it('returns Monday through Sunday for a weekly range', () => {
    const { start, end } = weekRange(new Date(2026, 8, 16));
    assert.deepEqual([start.getDay(), start.getDate()], [1, 14]);
    assert.deepEqual([end.getDay(), end.getDate()], [1, 21]);
  });
  it('honours Sunday as the selected first day of week', () => {
    const { start, end } = weekRange(new Date(2026, 8, 16), 0);
    assert.deepEqual([start.getDay(), start.getDate()], [0, 13]);
    assert.deepEqual([end.getDay(), end.getDate()], [0, 20]);
  });
  it('clamps month navigation to the target month instead of skipping February', () => {
    const forward = shiftCalendarAnchor(new Date(2026, 0, 31), 'month', 1);
    const backward = shiftCalendarAnchor(new Date(2026, 2, 31), 'month', -1);
    assert.deepEqual([forward.getFullYear(), forward.getMonth(), forward.getDate()], [2026, 1, 28]);
    assert.deepEqual([backward.getFullYear(), backward.getMonth(), backward.getDate()], [2026, 1, 28]);
  });
  it('rejects invalid event ranges before calling the API', () => {
    assert.equal(eventPayload({ calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T09:00', summary: '', description: '', location: '', url: '', organizer: '' }), null);
    assert.equal(eventPayload({ calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T10:00', summary: '', description: '', location: '', url: '', organizer: '' }), null);
  });
  it('requires a sender account and recipients when invitations are enabled', () => {
    const base = { calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T11:00', summary: 'Planning', description: '', location: '', url: '', organizer: '', sendInvites: true, attendees: ['guest@example.test'] };
    assert.equal(eventPayload(base), null);
    assert.equal(eventPayload({ ...base, inviteAccountId: 'account-1', attendees: [] }), null);
    assert.deepEqual(eventPayload({ ...base, inviteAccountId: 'account-1' }).attendees, ['guest@example.test']);
  });
  it('converts date field values when toggling all-day mode', () => {
    const timed = { allDay: false, startsAt: '2026-09-10T09:30', endsAt: '2026-09-10T10:30' };
    assert.deepEqual(toggleAllDayTimes(timed, true), { ...timed, allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-10' });
    assert.deepEqual(toggleAllDayTimes({ ...timed, allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-11' }, false), { ...timed, allDay: false, startsAt: '2026-09-10T00:00', endsAt: '2026-09-11T00:00' });
  });
  it('preserves selected all-day dates as UTC date boundaries', () => {
    const payload = eventPayload({ calendarId: 'one', allDay: true, startsAt: '2026-09-10', endsAt: '2026-09-11', summary: '', description: '', location: '', url: '', organizer: '' });
    assert.equal(payload.startsAt, '2026-09-10T00:00:00.000Z');
    assert.equal(payload.endsAt, '2026-09-11T00:00:00.000Z');
  });
  it('keeps an all-day event on its selected local calendar day west of UTC', () => {
    const originalTimeZone = globalThis.process.env.TZ;
    globalThis.process.env.TZ = 'America/Los_Angeles';
    try {
      const event = { all_day: true, starts_at: '2026-09-10T00:00:00.000Z', ends_at: '2026-09-11T00:00:00.000Z' };
      assert.equal(eventsForDay([event], new Date(2026, 8, 9)).length, 0);
      assert.equal(eventsForDay([event], new Date(2026, 8, 10)).length, 1);
    } finally {
      globalThis.process.env.TZ = originalTimeZone;
    }
  });
  it('includes events overlapping a day, including multi-day events', () => {
    assert.equal(eventsForDay([{ starts_at: '2026-09-10T22:00:00.000Z', ends_at: '2026-09-11T02:00:00.000Z' }], new Date(2026, 8, 11)).length, 1);
  });
});
