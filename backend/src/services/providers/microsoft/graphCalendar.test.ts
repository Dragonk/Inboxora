import { describe, expect, it, vi } from 'vitest';

// The adapter never sees a token; the grant service is stubbed so the HTTP layer is what is exercised.
const tokenMock = vi.hoisted(() => vi.fn(async () => ({
  accessToken: 'graph-token-1', expiresAt: new Date(Date.now() + 3600_000), generation: 1, refreshed: false, scopes: [],
})));
vi.mock('../../providerTokenService.js', () => ({ getMicrosoftAccessToken: tokenMock }));
vi.mock('../../providerAuthService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providerAuthService.js')>()),
  microsoftConfigFromEnv: () => ({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://x/cb', tenantId: 'common' }),
}));

import {
  buildGraphEventICalendar,
  buildGraphSeriesICalendar,
  fetchGraphCalendarEventsPage,
  graphCalendarAllowsWrites,
  graphCalendarColor,
  graphEventGroupId,
  graphEventIsCancelled,
  graphRecurrenceRule,
  groupGraphEvents,
} from './graphCalendar.js';
import type { GraphEvent } from './graphCalendar.js';
import { projectCalendarResource } from '../../../utils/calendarRecurrence.js';

const api = { userId: 'user-1', connectionId: 'connection-1' };

function timed(overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: 'AAMkAD-evt-1',
    iCalUId: 'standup@contoso.test',
    subject: 'Standup',
    start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'Europe/Warsaw' },
    end: { dateTime: '2026-09-01T09:30:00.0000000', timeZone: 'Europe/Warsaw' },
    ...overrides,
  };
}

describe('Graph recurrence becomes an RRULE', () => {
  it('maps every pattern type Graph defines', () => {
    expect(graphRecurrenceRule({ type: 'daily' }, { type: 'noEnd' })).toBe('RRULE:FREQ=DAILY');
    expect(graphRecurrenceRule({ type: 'daily', interval: 3 }, { type: 'noEnd' })).toBe('RRULE:FREQ=DAILY;INTERVAL=3');
    expect(graphRecurrenceRule(
      { type: 'weekly', daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'sunday' },
      { type: 'noEnd' },
    )).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU');
    expect(graphRecurrenceRule({ type: 'absoluteMonthly', dayOfMonth: 15 }, { type: 'noEnd' }))
      .toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=15');
    expect(graphRecurrenceRule({ type: 'relativeMonthly', daysOfWeek: ['tuesday'], index: 'last' }, { type: 'noEnd' }))
      .toBe('RRULE:FREQ=MONTHLY;BYDAY=-1TU');
    expect(graphRecurrenceRule({ type: 'absoluteYearly', month: 9, dayOfMonth: 1 }, { type: 'noEnd' }))
      .toBe('RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=1');
    expect(graphRecurrenceRule({ type: 'relativeYearly', month: 11, daysOfWeek: ['thursday'], index: 'fourth' }, { type: 'noEnd' }))
      .toBe('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH');
  });

  it('maps the range to COUNT or an inclusive UTC UNTIL', () => {
    expect(graphRecurrenceRule({ type: 'daily' }, { type: 'numbered', numberOfOccurrences: 4 }))
      .toBe('RRULE:FREQ=DAILY;COUNT=4');
    expect(graphRecurrenceRule({ type: 'daily' }, { type: 'endDate', endDate: '2026-12-31' }))
      .toBe('RRULE:FREQ=DAILY;UNTIL=20261231T235959Z');
  });

  it('refuses a rule it cannot express rather than guessing', () => {
    expect(graphRecurrenceRule(null, { type: 'noEnd' })).toBeNull();
    expect(graphRecurrenceRule({ type: 'unknownKind' }, { type: 'noEnd' })).toBeNull();
    // A relative pattern with no day, an impossible month and a numbered range with no count are all
    // incomplete, and a half-built rule would silently move a meeting.
    expect(graphRecurrenceRule({ type: 'relativeMonthly', index: 'second' }, { type: 'noEnd' })).toBeNull();
    expect(graphRecurrenceRule({ type: 'absoluteYearly', month: 13 }, { type: 'noEnd' })).toBeNull();
    expect(graphRecurrenceRule({ type: 'daily' }, { type: 'numbered' })).toBeNull();
  });
});

describe('a Graph event becomes one iCalendar resource', () => {
  it('writes the wall time with its TZID and a real VTIMEZONE', () => {
    const raw = buildGraphEventICalendar(timed(), { defaultTimeZone: null });
    expect(raw).toBeTruthy();
    expect(raw).toContain('DTSTART;TZID=Europe/Warsaw:20260901T090000');
    expect(raw).toContain('DTEND;TZID=Europe/Warsaw:20260901T093000');
    expect(raw).toContain('BEGIN:VTIMEZONE');
    expect(raw).toContain('UID:standup@contoso.test');
    expect(raw).toContain('PRODID:-//Inboxora//Microsoft Graph adapter//EN');

    // A DST boundary in the covered window is what the VTIMEZONE is there for.
    const projected = projectCalendarResource(
      { id: 'row', calendar_id: 'cal', raw_ical: raw! }, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'),
    );
    expect(projected.map(event => event.starts_at?.toISOString())).toEqual(['2026-09-01T07:00:00.000Z']);
  });

  it('keeps an all-day event date-valued', () => {
    const raw = buildGraphEventICalendar(timed({
      isAllDay: true,
      start: { dateTime: '2026-09-01T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-02T00:00:00.0000000', timeZone: 'UTC' },
    }));
    expect(raw).toContain('DTSTART;VALUE=DATE:20260901');
    expect(raw).toContain('DTEND;VALUE=DATE:20260902');
    expect(raw).not.toContain('TZID=UTC');
  });

  it('stores a UTC stamp as an instant, not a floating time', () => {
    const raw = buildGraphEventICalendar(timed({
      start: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-01T09:30:00.0000000', timeZone: 'UTC' },
    }));
    expect(raw).toContain('DTSTART:20260901T090000Z');
  });

  it('merges a master and its moved instance into one resource with a RECURRENCE-ID', () => {
    const master = timed({
      recurrence: { pattern: { type: 'weekly', daysOfWeek: ['tuesday'], interval: 1 }, range: { type: 'numbered', numberOfOccurrences: 4 } },
    });
    const occurrence: GraphEvent = {
      id: 'AAMkAD-evt-1_occ', seriesMasterId: 'AAMkAD-evt-1', type: 'occurrence',
      subject: 'Standup (moved)', originalStart: '2026-09-15T09:00:00.0000000',
      start: { dateTime: '2026-09-16T11:00:00.0000000', timeZone: 'Europe/Warsaw' },
      end: { dateTime: '2026-09-16T12:00:00.0000000', timeZone: 'Europe/Warsaw' },
    };
    const raw = buildGraphSeriesICalendar({ master, overrides: [occurrence], defaultTimeZone: null });
    expect(raw).toBeTruthy();
    expect(raw!.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(raw).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4');
    expect(raw).toContain('RECURRENCE-ID;TZID=Europe/Warsaw:20260915T090000');

    const projected = projectCalendarResource(
      { id: 'row', calendar_id: 'cal', raw_ical: raw! },
      new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'),
    );
    const starts = projected.map(event => event.starts_at?.toISOString());
    // The moved instance replaces its original slot and the rest of the series stands.
    expect(starts).toContain('2026-09-16T09:00:00.000Z');
    expect(starts).not.toContain('2026-09-15T07:00:00.000Z');
  });

  it('marks a cancelled event and maps attendees, organizer and a free/busy hint', () => {
    const raw = buildGraphEventICalendar(timed({
      isCancelled: true,
      showAs: 'free',
      organizer: { emailAddress: { address: 'boss@contoso.test', name: 'Boss' } },
      attendees: [
        { emailAddress: { address: 'a@contoso.test', name: 'A' }, status: { response: 'accepted' }, type: 'required' },
        { emailAddress: { address: 'b@contoso.test' }, status: { response: 'tentative' }, type: 'optional' },
      ],
    }));
    expect(raw).toContain('STATUS:CANCELLED');
    expect(raw).toContain('TRANSP:TRANSPARENT');
    expect(raw).toContain('ORGANIZER;CN=Boss:mailto:boss@contoso.test');
    expect(raw).toContain('ATTENDEE;CN=A;PARTSTAT=ACCEPTED:mailto:a@contoso.test');
    expect(raw).toContain('ATTENDEE;PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT:mailto:b@contoso.test');
  });

  it('carries an HTML body as an alternative description without losing the preview', () => {
    const raw = buildGraphEventICalendar(timed({
      body: { contentType: 'HTML', content: '<p>Agenda</p>' },
      bodyPreview: 'Agenda',
    }));
    expect(raw).toContain('X-ALT-DESC;FMTTYPE=text/html:<p>Agenda</p>');
    expect(raw).toContain('DESCRIPTION:Agenda');
  });

  it('groups instances with their master and a tombstone by its own id', () => {
    const master = timed();
    const occurrence: GraphEvent = { ...timed(), id: 'occ-1', seriesMasterId: 'AAMkAD-evt-1', type: 'occurrence' };
    const removed: GraphEvent = { id: 'AAMkAD-evt-2', '@removed': { reason: 'deleted' } };
    const groups = groupGraphEvents([master, occurrence, removed]);
    expect(groups.get('AAMkAD-evt-1')?.master?.id).toBe('AAMkAD-evt-1');
    expect(groups.get('AAMkAD-evt-1')?.overrides.map(event => event.id)).toEqual(['occ-1']);
    expect(groups.get('AAMkAD-evt-2')?.master?.id).toBe('AAMkAD-evt-2');
    expect(graphEventGroupId(occurrence)).toBe('AAMkAD-evt-1');
    expect(graphEventIsCancelled(removed)).toBe(true);
    expect(graphEventIsCancelled(master)).toBe(false);
  });
});

describe('Graph calendar permissions and colour', () => {
  it('treats an absent canEdit as not editable', () => {
    expect(graphCalendarAllowsWrites({ id: 'c', canEdit: true })).toBe(true);
    expect(graphCalendarAllowsWrites({ id: 'c', canEdit: false })).toBe(false);
    expect(graphCalendarAllowsWrites({ id: 'c' })).toBe(false);
  });

  it('prefers the hex colour and maps a named one otherwise', () => {
    expect(graphCalendarColor({ id: 'c', hexColor: '#aabbcc' })).toBe('#aabbcc');
    expect(graphCalendarColor({ id: 'c', color: 'lightBlue' })).toBe('#0f6cbd');
    expect(graphCalendarColor({ id: 'c' })).toBe('#0f6cbd');
  });
});

describe('the Graph event delta page', () => {
  it('asks the delta endpoint with only the parameters the delta function accepts, and follows an absolute link', async () => {
    const calls: Array<{ url: string; prefer: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), prefer: new Headers(init?.headers).get('prefer') });
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({
          value: [timed()],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$skiptoken=abc',
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events/delta?$deltatoken=def',
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const options = { ...api, fetchImpl };
    const page = await fetchGraphCalendarEventsPage(options, 'cal-1');
    expect(calls[0].url).toContain('/me/calendars/cal-1/events/delta');
    // GRAPH-02: the delta function documents `$select`, `$expand`, `$filter`, `$orderby` and `$search` as
    // unsupported, and pages with `odata.maxpagesize` rather than `$top`. Either parameter makes the request
    // one the contract cannot answer, so neither is sent.
    const asked = decodeURIComponent(calls[0].url);
    expect(asked).not.toContain('$select');
    expect(asked).not.toContain('$top');
    expect(asked.toLowerCase()).not.toContain('maxpagesize=');
    expect(calls[0].prefer).toBe('odata.maxpagesize=100, outlook.timezone="UTC"');
    expect(page.events.map(event => event.id)).toEqual(['AAMkAD-evt-1']);
    expect(page.nextLink).toContain('$skiptoken=abc');
    expect(page.deltaLink).toContain('$deltatoken=def');

    await fetchGraphCalendarEventsPage(options, 'cal-1', { link: page.nextLink });
    expect(calls[1].url).toBe(page.nextLink);
  });
});
