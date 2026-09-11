// Standalone recurrence-projection regressions for the calendar audit.
//
// Run from the repository root after installing the backend lockfile:
//   (cd backend && npm ci)
//   node --test calendar-regressions.test.mjs
//
// These tests intentionally import the *current* backend utility (no copies of
// the algorithm) so a performance optimisation that shifts, drops or re-types
// occurrences fails here instead of silently changing what users see.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectCalendarResource } from './backend/src/utils/calendarRecurrence.js';

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//Regressions//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function row(id, uid, lines, startsAt, endsAt, allDay = false) {
  return {
    id,
    calendar_id: 'cal-1',
    uid,
    raw_ical: ics(lines),
    summary: uid,
    starts_at: new Date(startsAt),
    ends_at: new Date(endsAt),
    all_day: allDay,
  };
}

function starts(out) {
  return out.map(event => new Date(event.starts_at).toISOString());
}

function recurrenceIds(out) {
  return out.map(event => String(event.recurrence_id));
}

const SEPT = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-15T00:00:00Z') };

describe('calendar recurrence projection regressions', () => {
  it('keeps DAILY 09:00 occurrences at 09:00 when the series started before the window', () => {
    const out = projectCalendarResource(row('r-daily', 'daily-9', [
      'BEGIN:VEVENT', 'UID:daily-9', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    ], '2026-01-05T09:00:00Z', '2026-01-05T10:00:00Z'), SEPT.from, SEPT.to);
    assert.equal(out.length, 14);
    for (const event of out) {
      assert.equal(new Date(event.starts_at).toISOString().slice(11), '09:00:00.000Z');
      assert.equal(new Date(event.ends_at).toISOString().slice(11), '10:00:00.000Z');
      assert.equal(event.all_day, false);
    }
  });

  it('keeps all-day series flagged all-day with DATE recurrence ids', () => {
    const out = projectCalendarResource(row('r-allday', 'allday-1', [
      'BEGIN:VEVENT', 'UID:allday-1', 'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260902', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    ], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', true), SEPT.from, SEPT.to);
    assert.equal(out.length, 14);
    for (const event of out) {
      assert.equal(event.all_day, true);
      assert.match(String(event.recurrence_id), /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.deepEqual(starts(out).slice(0, 2), ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
  });

  it('preserves the INTERVAL=2 weekly phase instead of restarting it at the window', () => {
    const out = projectCalendarResource(row('r-weekly', 'weekly-2', [
      'BEGIN:VEVENT', 'UID:weekly-2', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260105T140000Z', 'DTEND:20260105T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2', 'END:VEVENT',
    ], '2026-01-05T14:00:00Z', '2026-01-05T15:00:00Z'), SEPT.from, SEPT.to);
    assert.deepEqual(starts(out), ['2026-09-14T14:00:00.000Z']);
    assert.deepEqual(recurrenceIds(out), ['2026-09-14T14:00:00Z']);
  });

  it('never drifts a MONTHLY rule anchored on the 31st to the 1st of a month', () => {
    const out = projectCalendarResource(row('r-monthly', 'monthly-31', [
      'BEGIN:VEVENT', 'UID:monthly-31', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260131T090000Z', 'DTEND:20260131T100000Z', 'RRULE:FREQ=MONTHLY', 'END:VEVENT',
    ], '2026-01-31T09:00:00Z', '2026-01-31T10:00:00Z'), new Date('2026-03-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    assert.deepEqual(starts(out), ['2026-03-31T09:00:00.000Z']);
  });

  it('returns nothing for a COUNT series that ended before the window', () => {
    const out = projectCalendarResource(row('r-count', 'count-3', [
      'BEGIN:VEVENT', 'UID:count-3', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260105T140000Z', 'DTEND:20260105T150000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
    ], '2026-01-05T14:00:00Z', '2026-01-05T15:00:00Z'), SEPT.from, SEPT.to);
    assert.equal(out.length, 0);
  });

  it('omits an EXDATE occurrence from the projected window', () => {
    const out = projectCalendarResource(row('r-exdate', 'exdate-1', [
      'BEGIN:VEVENT', 'UID:exdate-1', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z', 'RRULE:FREQ=DAILY',
      'EXDATE:20260902T090000Z', 'END:VEVENT',
    ], '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'), SEPT.from, SEPT.to);
    assert.equal(out.length, 13);
    assert.ok(!starts(out).includes('2026-09-02T09:00:00.000Z'));
    assert.ok(starts(out).includes('2026-09-03T09:00:00.000Z'));
  });

  it('includes an exception moved into the window from an occurrence outside it', () => {
    const out = projectCalendarResource(row('r-moved', 'moved-1', [
      'BEGIN:VEVENT', 'UID:moved-1', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260801T090000Z', 'DTEND:20260801T100000Z', 'RRULE:FREQ=DAILY;COUNT=10', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:moved-1', 'DTSTAMP:20260101T000000Z',
      'RECURRENCE-ID:20260803T090000Z', 'DTSTART:20260905T090000Z', 'DTEND:20260905T100000Z', 'END:VEVENT',
    ], '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'), SEPT.from, SEPT.to);
    assert.deepEqual(starts(out), ['2026-09-05T09:00:00.000Z']);
  });

  it('drops a CANCELLED exception occurrence', () => {
    const out = projectCalendarResource(row('r-cancelled', 'cancelled-1', [
      'BEGIN:VEVENT', 'UID:cancelled-1', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:cancelled-1', 'DTSTAMP:20260101T000000Z',
      'RECURRENCE-ID:20260902T090000Z', 'DTSTART:20260902T090000Z', 'DTEND:20260902T100000Z',
      'STATUS:CANCELLED', 'END:VEVENT',
    ], '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'), SEPT.from, SEPT.to);
    assert.equal(out.length, 13);
    assert.ok(!starts(out).includes('2026-09-02T09:00:00.000Z'));
  });

  it('keeps a multi-day occurrence that starts before the window and ends inside it', () => {
    const out = projectCalendarResource(row('r-cross', 'cross-left', [
      'BEGIN:VEVENT', 'UID:cross-left', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260830T120000Z', 'DTEND:20260901T120000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    ], '2026-08-30T12:00:00Z', '2026-09-01T12:00:00Z'), SEPT.from, SEPT.to);
    assert.deepEqual(starts(out), [
      '2026-08-30T12:00:00.000Z',
      '2026-09-06T12:00:00.000Z',
      '2026-09-13T12:00:00.000Z',
    ]);
    assert.equal(new Date(out[0].ends_at).toISOString(), '2026-09-01T12:00:00.000Z');
  });
});
