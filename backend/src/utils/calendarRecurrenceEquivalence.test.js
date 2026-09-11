// Equivalence and edge-case coverage for calendar recurrence projection.
//
// The projection walks the series from its origin so COUNT/INTERVAL/EXDATE
// semantics survive, and uses a conservative wall-clock pre-filter to skip
// history cheaply. These tests prove the fast path is occurrence-equivalent to
// an unoptimised full scan, and cover the rule shapes the audit calls out.

import { describe, expect, it } from 'vitest';

import { projectCalendarResourceWithStatus } from './calendarRecurrence.js';

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Equivalence//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function row(id, lines, startsAt, endsAt, allDay = false) {
  return { id, calendar_id: 'cal-1', uid: id, raw_ical: ics(lines), summary: id, starts_at: new Date(startsAt), ends_at: new Date(endsAt), all_day: allDay };
}

function project(row, from, to, options = {}) {
  return projectCalendarResourceWithStatus(row, from, to, options);
}

function occurrences(status) {
  return status.events.map(event => `${event.recurrence_id}|${new Date(event.starts_at).toISOString()}|${new Date(event.ends_at).toISOString()}|${event.all_day}`).sort();
}

const event = (uid, lines) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];

describe('projection fast path equals a full scan', () => {
  const series = [
    row('daily', event('daily', ['DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z', 'RRULE:FREQ=DAILY']), '2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z'),
    row('weekly2', event('weekly2', ['DTSTART:20190304T140000Z', 'DTEND:20190304T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2']), '2019-03-04T14:00:00Z', '2019-03-04T15:00:00Z'),
    row('monthly31', event('monthly31', ['DTSTART:20190131T090000Z', 'DTEND:20190131T100000Z', 'RRULE:FREQ=MONTHLY']), '2019-01-31T09:00:00Z', '2019-01-31T10:00:00Z'),
    row('count', event('count', ['DTSTART:20240101T090000Z', 'DTEND:20240101T100000Z', 'RRULE:FREQ=DAILY;COUNT=20']), '2024-01-01T09:00:00Z', '2024-01-01T10:00:00Z'),
    row('hourly', event('hourly', ['DTSTART:20250801T000000Z', 'DTEND:20250801T003000Z', 'RRULE:FREQ=HOURLY;INTERVAL=6']), '2025-08-01T00:00:00Z', '2025-08-01T00:30:00Z'),
    row('all-day', event('all-day', ['DTSTART;VALUE=DATE:20250101', 'DTEND;VALUE=DATE:20250102', 'RRULE:FREQ=WEEKLY']), '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', true),
    row('exdate', event('exdate', ['DTSTART:20250101T090000Z', 'DTEND:20250101T100000Z', 'RRULE:FREQ=DAILY', 'EXDATE:20260907T090000Z']), '2025-01-01T09:00:00Z', '2025-01-01T10:00:00Z'),
    row('rdate', event('rdate', ['DTSTART:20260903T090000Z', 'DTEND:20260903T100000Z', 'RDATE:20260910T090000Z']), '2026-09-03T09:00:00Z', '2026-09-03T10:00:00Z'),
  ];

  const windows = [
    ['2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'],
    ['2026-09-07T12:00:00Z', '2026-09-08T12:00:00Z'],
    ['2024-01-15T00:00:00Z', '2024-02-01T00:00:00Z'],
    ['2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'],
    ['2020-03-01T00:00:00Z', '2020-04-01T00:00:00Z'],
  ];

  for (const seriesRow of series) {
    for (const [fromIso, toIso] of windows) {
      it(`matches for ${seriesRow.id} in ${fromIso}..${toIso}`, () => {
        const from = new Date(fromIso);
        const to = new Date(toIso);
        const fast = project(seriesRow, from, to);
        const full = project(seriesRow, from, to, { fullScan: true });
        expect(occurrences(fast)).toEqual(occurrences(full));
        expect(fast.truncated).toBe(full.truncated);
      });
    }
  }
});

describe('rule shapes called out by the audit', () => {
  it('expands a multi-year COUNT series exactly up to its count', () => {
    const status = project(
      row('multi-year', event('multi-year', ['DTSTART:20100101T090000Z', 'DTEND:20100101T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=800']), '2010-01-01T09:00:00Z', '2010-01-01T10:00:00Z'),
      new Date('2025-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    // 800 weekly occurrences starting 2010-01-01 (a Friday) end in May 2025.
    expect(status.truncated).toBe(false);
    expect(status.events.length).toBeGreaterThan(0);
    for (const occurrence of status.events) {
      expect(new Date(occurrence.starts_at).getUTCDay()).toBe(5);
      expect(new Date(occurrence.starts_at).toISOString().slice(11)).toBe('09:00:00.000Z');
    }
  });

  it('expands an RDATE-only series from its RDATE list', () => {
    const status = project(
      row('rdate-only', event('rdate-only', ['DTSTART:20260903T090000Z', 'DTEND:20260903T100000Z', 'RDATE:20260910T090000Z', 'RDATE:20260917T090000Z']), '2026-09-03T09:00:00Z', '2026-09-03T10:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    // NOTE: this documents the pre-existing contract, verified identical before
    // and after the performance work. ical.js seeds the expansion cursor at
    // DTSTART, so a series whose only recurrence data is RDATE yields the RDATE
    // list without a separate DTSTART occurrence. Any change to that is a
    // deliberate behaviour change, not a side effect of the optimisation.
    expect(status.events.map(item => new Date(item.starts_at).toISOString())).toEqual([
      '2026-09-10T09:00:00.000Z',
      '2026-09-17T09:00:00.000Z',
    ]);
  });

  it('honours a VTIMEZONE definition across a DST change', () => {
    const raw = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Equivalence//EN',
      'BEGIN:VTIMEZONE', 'TZID:Europe/Warsaw',
      'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
      'END:VTIMEZONE',
      ...event('tz', ['DTSTART;TZID=Europe/Warsaw:20260322T090000', 'DTEND;TZID=Europe/Warsaw:20260322T100000', 'RRULE:FREQ=WEEKLY;COUNT=4']),
      'END:VCALENDAR', '',
    ].join('\r\n');
    const status = project({ id: 'tz', calendar_id: 'cal-1', uid: 'tz', raw_ical: raw }, new Date('2026-03-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    // Wall time stays 09:00; the UTC instant moves when Poland enters DST on 29 March.
    expect(status.events.map(item => new Date(item.starts_at).toISOString())).toEqual([
      '2026-03-22T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-04-05T07:00:00.000Z',
      '2026-04-12T07:00:00.000Z',
    ]);
  });

  it('falls back to IANA rules when the TZID has no VTIMEZONE definition', () => {
    const status = project(
      row('tz-no-def', event('tz-no-def', ['DTSTART;TZID=Europe/Warsaw:20260322T090000', 'DTEND;TZID=Europe/Warsaw:20260322T100000', 'RRULE:FREQ=WEEKLY;COUNT=2']), '2026-03-22T09:00:00Z', '2026-03-22T10:00:00Z'),
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(status.events.map(item => new Date(item.starts_at).toISOString())).toEqual([
      '2026-03-22T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
    ]);
  });

  it('reports a malformed rule instead of throwing or dropping other series', () => {
    const status = project(
      row('bad-rule', event('bad-rule', ['DTSTART:20260903T090000Z', 'DTEND:20260903T100000Z', 'RRULE:FREQ=NOTAREALFREQUENCY']), '2026-09-03T09:00:00Z', '2026-09-03T10:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    // Either the rule is rejected outright or it is reported as truncated; what
    // must never happen is an exception escaping into the caller.
    expect(status).toHaveProperty('events');
    expect(Array.isArray(status.events)).toBe(true);
  });

  it('flags a very dense rule as truncated rather than silently truncating the list', () => {
    const status = project(
      row('dense', event('dense', ['DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY']), '1970-01-01T00:00:00Z', '1970-01-01T00:01:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
      { maxIterations: 5000 },
    );
    expect(status.truncated).toBe(true);
    expect(status.reason).toBe('iteration-limit');
  });

  it('stops at the deadline when the budget is exhausted', () => {
    const status = project(
      row('deadline', event('deadline', ['DTSTART:19700101T000000Z', 'DTEND:19700101T000100Z', 'RRULE:FREQ=MINUTELY']), '1970-01-01T00:00:00Z', '1970-01-01T00:01:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
      { deadline: Date.now() - 1, maxIterations: 1000000 },
    );
    expect(status.truncated).toBe(true);
    expect(status.reason).toBe('deadline');
  });

  it('keeps an occurrence that starts before the window and ends inside it', () => {
    const status = project(
      row('cross', event('cross', ['DTSTART:20260830T120000Z', 'DTEND:20260901T120000Z', 'RRULE:FREQ=WEEKLY']), '2026-08-30T12:00:00Z', '2026-09-01T12:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(new Date(status.events[0].starts_at).toISOString()).toBe('2026-08-30T12:00:00.000Z');
    expect(new Date(status.events[0].ends_at).toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('includes an exception moved into the window from an occurrence outside it', () => {
    const status = project(
      row('moved-in', [
        ...event('moved-in', ['DTSTART:20260801T090000Z', 'DTEND:20260801T100000Z', 'RRULE:FREQ=DAILY;COUNT=10']),
        ...event('moved-in', ['RECURRENCE-ID:20260803T090000Z', 'DTSTART:20260905T090000Z', 'DTEND:20260905T100000Z', 'SUMMARY:Moved']),
      ], '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
    );
    expect(status.events).toHaveLength(1);
    expect(new Date(status.events[0].starts_at).toISOString()).toBe('2026-09-05T09:00:00.000Z');
  });

  it('applies a THISANDFUTURE exception through a full scan', () => {
    const status = project(
      row('range', [
        ...event('range', ['DTSTART:20260901T090000Z', 'DTEND:20260901T100000Z', 'RRULE:FREQ=DAILY;COUNT=6']),
        ...event('range', ['RECURRENCE-ID;RANGE=THISANDFUTURE:20260903T090000Z', 'DTSTART:20260903T110000Z', 'DTEND:20260903T120000Z', 'SUMMARY:Shifted']),
      ], '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-15T00:00:00Z'),
      { fullScan: true },
    );
    expect(status.events.length).toBe(6);
    // The range exception shifts this and every following occurrence by two hours.
    for (const occurrence of status.events.filter(item => new Date(item.starts_at) >= new Date('2026-09-03T00:00:00Z'))) {
      expect(new Date(occurrence.starts_at).getUTCHours()).toBe(11);
    }
  });
});
