import { describe, expect, it } from 'vitest';
import { calendarResources, mergeCalendarResource, projectCalendarResource, truncateSeriesBefore } from './calendarRecurrence.js';
import { parseCalendarEvent } from './ical.js';
const resource = (extra = '', exception = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:series', 'DTSTART;TZID=Europe/Warsaw:20260322T090000', 'DTEND;TZID=Europe/Warsaw:20260322T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly', 'DESCRIPTION:Full agenda', extra, 'END:VEVENT', exception, 'END:VCALENDAR'].filter(Boolean).join('\r\n');
const row = raw => ({ id: 'row', calendar_id: 'cal', raw_ical: raw });
const from = new Date('2026-03-01'), to = new Date('2026-05-01');
describe('recurring calendar resources', () => {
 it('expands a series across DST while preserving wall time and descriptions', () => {
   const events = projectCalendarResource(row(resource()), from, to);
   expect(events.map(event => event.starts_at.toISOString())).toEqual(['2026-03-22T08:00:00.000Z', '2026-03-29T07:00:00.000Z', '2026-04-05T07:00:00.000Z', '2026-04-12T07:00:00.000Z']);
   expect(events.every(event => event.description === 'Full agenda' && event.series_id === 'row')).toBe(true);
   expect(projectCalendarResource(row(resource()), new Date('2026-05-01'), new Date('2026-06-01'))).toEqual([]);
 });
 it('honors excluded dates and moved exceptions, grouping by UID on import', () => {
   const exception = ['BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID;TZID=Europe/Warsaw:20260405T090000', 'DTSTART;TZID=Europe/Warsaw:20260406T110000', 'DTEND;TZID=Europe/Warsaw:20260406T120000', 'SUMMARY:Moved', 'END:VEVENT'].join('\r\n');
   const raw = resource('EXDATE;TZID=Europe/Warsaw:20260329T090000', exception);
   expect(calendarResources(raw)).toHaveLength(1);
   expect(parseCalendarEvent(raw)?.uid).toBe('series');
   const events = projectCalendarResource(row(raw), from, to);
   expect(events).toHaveLength(3);
   expect(events.find(event => event.summary === 'Moved').starts_at.toISOString()).toBe('2026-04-06T09:00:00.000Z');
 });
 it('edits and cancels one instance without removing recurrence or alarms', () => {
   const raw = resource('BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM');
   const replacement = resource().replace('SUMMARY:Weekly','SUMMARY:Changed').replace('20260322T090000','20260329T120000').replace('20260322T100000','20260329T130000');
   const edited = mergeCalendarResource(raw, replacement, '2026-03-29T09:00:00');
   const events = projectCalendarResource(row(edited), from, to);
   expect(events).toHaveLength(4); expect(events.filter(event => event.summary === 'Changed')).toHaveLength(1);
   expect(edited).toContain('BEGIN:VALARM');
   const cancelled = mergeCalendarResource(edited, replacement, '2026-03-29T09:00:00', true);
   expect(projectCalendarResource(row(cancelled), from, to)).toHaveLength(3);
 });
});

// A description is displayed by the same sanitized HTML pipeline as a mail body,
// so an HTML alternative is preserved as markup (not flattened to text) and is
// cleaned on the way out of the parser: scripts and event handlers never reach
// the client, while the formatting the sender wrote survives.
it('keeps an HTML-only description as sanitized mail-like markup', () => {
 const raw = resource().replace('DESCRIPTION:Full agenda', 'X-ALT-DESC;FMTTYPE=text/html:<p>Plan &amp; details</p><script>hidden()</script><p><a href="javascript:alert(1)" onclick="x()">Next</a></p>');
 const expected = '<p>Plan &amp; details</p><p><a rel="noopener noreferrer" target="_blank">Next</a></p>';
 expect(projectCalendarResource(row(raw), from, to)[0].description).toBe(expected);
 expect(parseCalendarEvent(raw).description).toBe(expected);
});

it('stores a plain-text description verbatim and sanitizes raw markup in DESCRIPTION', () => {
 expect(parseCalendarEvent(resource()).description).toBe('Full agenda');
 const raw = resource().replace('DESCRIPTION:Full agenda', 'DESCRIPTION:<p>Line one</p><p>Line&nbsp;two</p><script>bad()</script>');
 expect(parseCalendarEvent(raw).description).toBe('<p>Line one</p><p>Line\u00a0two</p>');
});

// "Cancel this and every following occurrence".
//
// The natural-looking implementation is an exception carrying
// `RECURRENCE-ID;RANGE=THISANDFUTURE` with `STATUS:CANCELLED`, and it does *nothing* here:
// a cancelled range exception left the series unchanged when measured, while a range
// exception does reschedule the tail. Truncating the rule with UNTIL is what actually ends
// the series, and it is what other calendars write, so the result stays portable.
describe('cancelling a series from an occurrence onward', () => {
  const seriesWith = (extra = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:s',
    'DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTEND;TZID=Europe/Warsaw:20260105T100000',
    'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Daily', 'END:VEVENT', ...extra, 'END:VCALENDAR'].join('\r\n');
  const starts = raw => projectCalendarResource(row(raw), new Date('2026-01-01'), new Date('2026-03-01'))
    .map(event => event.starts_at.toISOString().slice(5, 16));

  it('ends the series just before the named occurrence', () => {
    const result = truncateSeriesBefore(seriesWith(), '2026-01-09T09:00:00');
    expect(starts(result.raw)).toEqual(['01-05T08:00', '01-06T08:00', '01-07T08:00', '01-08T08:00']);
    expect(result.empty).toBe(false);
  });

  it('reports that cutting at the first occurrence leaves nothing', () => {
    const result = truncateSeriesBefore(seriesWith(), '2026-01-05T09:00:00');
    expect(starts(result.raw)).toEqual([]);
    expect(result.empty).toBe(true);
  });

  it('keeps an earlier moved instance and drops the ones past the cut', () => {
    const earlier = ['BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID;TZID=Europe/Warsaw:20260106T090000',
      'DTSTART;TZID=Europe/Warsaw:20260106T150000', 'DTEND;TZID=Europe/Warsaw:20260106T160000', 'SUMMARY:Early', 'END:VEVENT'];
    const later = ['BEGIN:VEVENT', 'UID:s', 'RECURRENCE-ID;TZID=Europe/Warsaw:20260112T090000',
      'DTSTART;TZID=Europe/Warsaw:20260112T150000', 'DTEND;TZID=Europe/Warsaw:20260112T160000', 'SUMMARY:Later', 'END:VEVENT'];
    const result = truncateSeriesBefore(seriesWith([...earlier, ...later]), '2026-01-09T09:00:00');
    // The moved instance before the cut survives at its moved time; the one after is gone.
    expect(starts(result.raw)).toEqual(['01-05T08:00', '01-06T14:00', '01-07T08:00', '01-08T08:00']);
  });

  it('handles a date-valued series without leaving the boundary occurrence behind', () => {
    const raw = seriesWith().replace('DTSTART;TZID=Europe/Warsaw:20260105T090000', 'DTSTART;VALUE=DATE:20260105')
      .replace('DTEND;TZID=Europe/Warsaw:20260105T100000', 'DTEND;VALUE=DATE:20260106');
    const result = truncateSeriesBefore(raw, '2026-01-09');
    expect(projectCalendarResource(row(result.raw), new Date('2026-01-01'), new Date('2026-03-01')).map(event => event.starts_at.toISOString().slice(5, 10)))
      .toEqual(['01-05', '01-06', '01-07', '01-08']);
  });

  it('reports nothing to truncate for an event that does not recur', () => {
    expect(truncateSeriesBefore(seriesWith().replace('RRULE:FREQ=DAILY;COUNT=10\r\n', ''), '2026-01-09T09:00:00')).toBeNull();
  });
});
