import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVTimezone, formatOffset, isValidTimeZone, zoneOffsetMinutes } from '../../../utils/icalTimezone.js';
import { parseCalendarEvent } from '../../../utils/ical.js';
import { projectCalendarResource } from '../../../utils/calendarRecurrence.js';
import { buildGoogleEventICalendar, buildGoogleSeriesICalendar, fetchCalendarEvents, fetchCalendarList } from './googleCalendar.js';
import type { GoogleCalendarEvent } from './googleCalendar.js';

vi.mock('../../providerTokenService.js', () => ({
  getGoogleAccessToken: vi.fn(async () => ({
    accessToken: 'token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
  })),
}));

afterEach(() => { vi.unstubAllGlobals(); });

const API_OPTIONS = { userId: 'user-1', connectionId: 'connection-1', config: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' } };

describe('buildVTimezone', () => {
  it('uses the platform tz database for a DST zone', () => {
    const block = buildVTimezone('Europe/Warsaw', 2026, 2026);
    expect(block).toContain('BEGIN:VTIMEZONE');
    expect(block).toContain('TZID:Europe/Warsaw');
    // Last Sunday of March: 02:00 local +01:00 → 03:00 local +02:00.
    expect(block).toContain('TZOFFSETFROM:+0100');
    expect(block).toContain('TZOFFSETTO:+0200');
    expect(block).toContain('DTSTART:20260329T020000');
    // Last Sunday of October: 03:00 local +02:00 → 02:00 local +01:00.
    expect(block).toContain('DTSTART:20261025T030000');
    expect(block).toContain('END:VTIMEZONE');
  });

  it('defines a constant offset for a zone without transitions', () => {
    const block = buildVTimezone('UTC', 2026, 2026);
    expect(block).toContain('TZOFFSETFROM:+0000');
    expect(block).toContain('TZOFFSETTO:+0000');
    expect(block).not.toContain('DAYLIGHT');
  });

  it('rejects an unknown zone so the caller can fall back to UTC', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(buildVTimezone('Not/AZone', 2026, 2026)).toBeNull();
  });

  it('reports offsets and formats them in both hemispheres', () => {
    expect(zoneOffsetMinutes('Europe/Warsaw', new Date('2026-07-01T00:00:00Z'))).toBe(120);
    expect(zoneOffsetMinutes('Europe/Warsaw', new Date('2026-01-01T00:00:00Z'))).toBe(60);
    expect(zoneOffsetMinutes('America/New_York', new Date('2026-07-01T00:00:00Z'))).toBe(-240);
    expect(formatOffset(120)).toBe('+0200');
    expect(formatOffset(-270)).toBe('-0430');
    expect(formatOffset(0)).toBe('+0000');
  });

  it('produces a definition the projection can resolve to the right instant', () => {
    // This is the real contract: not "a block exists" but "the wall time becomes
    // the correct UTC instant in summer and in winter". One resource holds one UID.
    const timezone = buildVTimezone('Europe/Warsaw', 2026, 2026);
    expect(timezone).not.toBeNull();
    const project = (uid: string, start: string) => {
      const resource = [
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        String(timezone),
        'BEGIN:VEVENT', `UID:${uid}`,
        `DTSTART;TZID=Europe/Warsaw:${start}`,
        `DTEND;TZID=Europe/Warsaw:${start.slice(0, 9)}100000`,
        `SUMMARY:${uid}`,
        'END:VEVENT',
        'END:VCALENDAR', '',
      ].join('\r\n');
      const [event] = projectCalendarResource(
        { id: 'row', calendar_id: 'cal', raw_ical: resource },
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-12-31T00:00:00Z'),
      );
      return event?.starts_at?.toISOString();
    };
    // 09:00 CEST = 07:00Z, 09:00 CET = 08:00Z.
    expect(project('tz-summer', '20260715T090000')).toBe('2026-07-15T07:00:00.000Z');
    expect(project('tz-winter', '20260115T090000')).toBe('2026-01-15T08:00:00.000Z');
  });
});

describe('buildGoogleEventICalendar', () => {
  it('keeps a timed event in its zone with a usable VTIMEZONE', () => {
    const ical = buildGoogleEventICalendar({
      id: 'evt-1',
      iCalUID: 'evt-1@google.com',
      summary: 'Planning, review; notes',
      location: 'Room, 2',
      status: 'confirmed',
      start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-09-01T10:00:00+02:00', timeZone: 'Europe/Warsaw' },
      organizer: { email: 'owner@example.test', displayName: 'Team: Europe' },
      attendees: [{ email: 'guest@example.test', responseStatus: 'accepted' }, { email: 'maybe@example.test', responseStatus: 'tentative' }],
      updated: '2026-08-30T10:00:00Z',
    });
    expect(ical).toContain('BEGIN:VTIMEZONE');
    expect(ical).toContain('DTSTART;TZID=Europe/Warsaw:20260901T090000');
    expect(ical).toContain('DTSTAMP:20260830T100000Z');
    // Text values are escaped, the display name is quoted.
    expect(ical).toContain('SUMMARY:Planning\\, review\\; notes');
    expect(ical).toContain('LOCATION:Room\\, 2');
    expect(ical).toContain('ORGANIZER;CN="Team: Europe":mailto:owner@example.test');
    expect(ical).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:guest@example.test');
    expect(ical).toContain('ATTENDEE;PARTSTAT=TENTATIVE:mailto:maybe@example.test');

    const parsed = parseCalendarEvent(ical);
    expect(parsed?.uid).toBe('evt-1@google.com');
    expect(parsed?.startsAt.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('keeps an all-day event date-valued', () => {
    const ical = buildGoogleEventICalendar({
      id: 'evt-allday',
      start: { date: '2026-09-01' },
      end: { date: '2026-09-03' },
      summary: 'Conference',
    });
    expect(ical).toContain('DTSTART;VALUE=DATE:20260901');
    expect(ical).toContain('DTEND;VALUE=DATE:20260903');
    expect(ical).not.toContain('BEGIN:VTIMEZONE');
  });

  it('falls back to the exact UTC instant when the provider gives no usable zone', () => {
    const ical = buildGoogleEventICalendar({
      id: 'evt-utc',
      start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Not/AZone' },
      end: { dateTime: '2026-09-01T10:00:00+02:00', timeZone: 'Not/AZone' },
    });
    expect(ical).toContain('DTSTART:20260901T070000Z');
    expect(ical).toContain('DTEND:20260901T080000Z');
    expect(ical).not.toContain('BEGIN:VTIMEZONE');
  });

  it('refuses an event without a start or end', () => {
    expect(buildGoogleEventICalendar({ id: 'broken', start: { dateTime: 'nonsense' } })).toBeNull();
  });
});

describe('buildGoogleSeriesICalendar', () => {
  const master: GoogleCalendarEvent = {
    id: 'evt-master',
    iCalUID: 'master@google.com',
    status: 'confirmed',
    summary: 'Standup',
    updated: '2026-08-30T10:00:00Z',
    start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
    end: { dateTime: '2026-09-01T09:30:00+02:00', timeZone: 'Europe/Warsaw' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4'],
  };
  const moved: GoogleCalendarEvent = {
    id: 'evt-moved', iCalUID: 'master@google.com', recurringEventId: 'evt-master', status: 'confirmed',
    summary: 'Standup (moved)',
    originalStartTime: { dateTime: '2026-09-15T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
    start: { dateTime: '2026-09-16T11:00:00+02:00', timeZone: 'Europe/Warsaw' },
    end: { dateTime: '2026-09-16T12:00:00+02:00', timeZone: 'Europe/Warsaw' },
  };
  const cancelled: GoogleCalendarEvent = {
    id: 'evt-cancelled', iCalUID: 'master@google.com', recurringEventId: 'evt-master', status: 'cancelled',
    originalStartTime: { dateTime: '2026-09-22T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
    start: { dateTime: '2026-09-22T09:00:00+02:00', timeZone: 'Europe/Warsaw' },
    end: { dateTime: '2026-09-22T09:30:00+02:00', timeZone: 'Europe/Warsaw' },
  };

  it('keeps one series with its rule, its moved instance and its cancelled instance', () => {
    const ical = buildGoogleSeriesICalendar({ master, overrides: [moved, cancelled] });
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4');
    expect(ical).toContain('RECURRENCE-ID;TZID=Europe/Warsaw:20260915T090000');
    expect(ical).toContain('SUMMARY:Standup (moved)');
    expect(ical).toContain('STATUS:CANCELLED');
    // One VTIMEZONE for the whole resource.
    expect(ical?.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);

    const events = projectCalendarResource(
      { id: 'row', calendar_id: 'cal', raw_ical: String(ical) },
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    const starts = events.map(event => event.starts_at?.toISOString()).sort();
    // Four weekly occurrences, one moved to the next day, one cancelled.
    expect(starts).toEqual([
      '2026-09-01T07:00:00.000Z',
      '2026-09-08T07:00:00.000Z',
      '2026-09-16T09:00:00.000Z',
    ]);
  });

  it('covers a decade of transitions for a series so a later DST boundary is defined', () => {
    const ical = buildGoogleSeriesICalendar({ master, overrides: [] });
    // Last Sunday of March 2036 must be inside the generated window.
    expect(ical).toContain('DTSTART:20360330T020000');
  });
});

describe('Google Calendar API calls', () => {
  const json = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body }) as Response;

  it('lists calendars, skipping deleted entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [{ id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: 'Europe/Warsaw' }, { id: 'gone', deleted: true }],
      nextPageToken: 'page-2',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchCalendarList(API_OPTIONS);
    expect(page.calendars).toEqual([{ id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: 'Europe/Warsaw' }]);
    expect(page.nextPageToken).toBe('page-2');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/users/me/calendarList');
  });

  it('asks for a baseline with a window and never expands instances', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [{ id: 'evt-1' }], nextSyncToken: 'sync-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchCalendarEvents(API_OPTIONS, 'primary', { timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-12-31T00:00:00Z' });
    expect(page.events).toHaveLength(1);
    expect(page.nextSyncToken).toBe('sync-1');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('singleEvents=false');
    expect(url).toContain('showDeleted=true');
    expect(url).toContain('timeMin=');
  });

  it('sends only the cursor on an incremental call, because Google rejects a window with it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [], nextSyncToken: 'sync-2' }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCalendarEvents(API_OPTIONS, 'primary', { syncToken: 'sync-1', timeMin: '2026-01-01T00:00:00Z', pageToken: 'p2' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('syncToken=sync-1');
    expect(url).toContain('pageToken=p2');
    expect(url).not.toContain('timeMin');
    expect(url).not.toContain('timeMax');
  });
});
