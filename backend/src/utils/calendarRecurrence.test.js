import { describe, expect, it } from 'vitest';
import { calendarResources, mergeCalendarResource, projectCalendarResource } from './calendarRecurrence.js';
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

it('renders HTML-only descriptions as safe readable text', () => {
 const raw = resource().replace('DESCRIPTION:Full agenda', 'X-ALT-DESC;FMTTYPE=text/html:<p>Plan &amp; details</p><script>hidden()</script><p>Next</p>');
 expect(projectCalendarResource(row(raw), from, to)[0].description).toBe('Plan & details\nNext');
 expect(parseCalendarEvent(raw).description).toBe('Plan & details\nNext');
});
