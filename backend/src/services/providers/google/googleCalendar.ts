import { googleApiFetch, googleApiJson, googleApiVoid, googleUrl } from './googleApiClient.js';
import type { GoogleApiOptions } from './googleApiClient.js';
import { buildVTimezone, isValidTimeZone } from '../../../utils/icalTimezone.js';
import {
  escapeICalendarParameter,
  escapeICalendarText,
  foldICalendarLine,
  formatICalendarUtc,
} from '../../../utils/icalText.js';

/**
 * Google Calendar read adapter (P09, calendars).
 *
 * A Google event is JSON, but the local model — and every DAV client — reads
 * iCalendar. The mapping below therefore preserves the series: a recurring event
 * keeps its `RRULE`/`EXDATE`, a modified instance becomes a `RECURRENCE-ID`
 * override, and the wall time is written with a real `VTIMEZONE` so a DST
 * boundary cannot shift the series. An all-day event stays date-valued.
 *
 * `singleEvents=false` is used deliberately: expanding instances here would
 * fragment the series, and the plan requires a recurring event to remain one.
 */

export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string | null;
  description?: string | null;
  timeZone?: string | null;
  accessRole?: string | null;
  primary?: boolean | null;
  selected?: boolean | null;
  deleted?: boolean | null;
  backgroundColor?: string | null;
}

export interface GoogleEventDateTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface GoogleCalendarEvent {
  id: string;
  iCalUID?: string | null;
  etag?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled' | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  htmlLink?: string | null;
  transparency?: 'opaque' | 'transparent' | null;
  sequence?: number | null;
  created?: string | null;
  updated?: string | null;
  organizer?: { email?: string | null; displayName?: string | null } | null;
  attendees?: Array<{ email?: string | null; displayName?: string | null; responseStatus?: string | null; optional?: boolean | null }> | null;
  start?: GoogleEventDateTime | null;
  end?: GoogleEventDateTime | null;
  recurrence?: string[] | null;
  recurringEventId?: string | null;
  originalStartTime?: GoogleEventDateTime | null;
}

export interface CalendarListPage {
  calendars: GoogleCalendarListEntry[];
  nextPageToken: string | null;
}

export interface CalendarEventsPage {
  events: GoogleCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

interface EventWindow {
  pageToken?: string | null;
  syncToken?: string | null;
  timeMin?: string | null;
  timeMax?: string | null;
  showDeleted?: boolean;
  maxResults?: number;
}

/** Google CalendarList.list permits at most 250 entries per request. */
export const GOOGLE_CALENDAR_LIST_MAX_RESULTS = 250;
/** Google Events.list permits at most 2500 entries per request. */
export const GOOGLE_CALENDAR_EVENTS_MAX_RESULTS = 2500;

export async function fetchCalendarList(options: GoogleApiOptions, input: { pageToken?: string | null } = {}): Promise<CalendarListPage> {
  const url = googleUrl(GOOGLE_CALENDAR_API_BASE, '/users/me/calendarList', {
    maxResults: GOOGLE_CALENDAR_LIST_MAX_RESULTS,
    pageToken: input.pageToken ?? undefined,
  });
  const body = await googleApiFetch<{ items?: GoogleCalendarListEntry[] | null; nextPageToken?: string | null }>(options, url);
  return {
    calendars: (Array.isArray(body.items) ? body.items : []).filter(entry => entry?.id && entry.deleted !== true),
    nextPageToken: body.nextPageToken ?? null,
  };
}

/**
 * One page of a calendar's events. A cursor the provider rejects surfaces as an
 * `INVALID_SYNC_CURSOR` GoogleApiError; the caller rebuilds from a baseline.
 */
export async function fetchCalendarEvents(options: GoogleApiOptions, calendarId: string, input: EventWindow = {}): Promise<CalendarEventsPage> {
  const incremental = Boolean(input.syncToken);
  const url = googleUrl(GOOGLE_CALENDAR_API_BASE, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    maxResults: Number.isFinite(input.maxResults) && Number(input.maxResults) > 0
      ? Math.min(GOOGLE_CALENDAR_EVENTS_MAX_RESULTS, Number(input.maxResults))
      : GOOGLE_CALENDAR_EVENTS_MAX_RESULTS,
    pageToken: input.pageToken ?? undefined,
    syncToken: input.syncToken ?? undefined,
    // Google rejects the window parameters together with a sync token.
    timeMin: incremental ? undefined : input.timeMin ?? undefined,
    timeMax: incremental ? undefined : input.timeMax ?? undefined,
    showDeleted: true,
    singleEvents: false,
  });
  const body = await googleApiFetch<{
    items?: GoogleCalendarEvent[] | null;
    nextPageToken?: string | null;
    nextSyncToken?: string | null;
  }>(options, url);
  return {
    events: (Array.isArray(body.items) ? body.items : []).filter(event => Boolean(event?.id)),
    nextPageToken: body.nextPageToken ?? null,
    nextSyncToken: body.nextSyncToken ?? null,
  };
}

// ── Writes (P09, calendar CRUD) ──────────────────────────────────────────────
//
// The three calls below are the only place a Google calendar event is created, changed or removed.
// The body is built by the adapter (`providerGoogleWrites.ts`) so the local model stays out of this
// file and the mapping is testable without a network.

/**
 * What Google sends to the attendees of a write.
 *
 * `none` is always sent explicitly rather than omitted: Google's default is "send nothing", but a
 * default is a guess about the user's intent, and Inboxora's own invitation mail is suppressed on a
 * provider calendar on the understanding that the provider was told what to do.
 */
export type GoogleSendUpdates = 'all' | 'externalOnly' | 'none';

/** The event body `events.insert` and `events.patch` accept. */
export interface GoogleEventWritePayload {
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  /** Complete iCalendar lines (`RRULE:…`), which is the form Google stores. */
  recurrence?: string[];
  attendees?: Array<{ email: string }>;
}

/** `events.insert`. The created event carries the id and iCalUID the local link is built from. */
export async function insertGoogleEvent(
  options: GoogleApiOptions,
  calendarId: string,
  payload: GoogleEventWritePayload,
  input: { sendUpdates: GoogleSendUpdates },
): Promise<GoogleCalendarEvent | null> {
  return googleApiJson<GoogleCalendarEvent>(
    options,
    googleUrl(GOOGLE_CALENDAR_API_BASE, `/calendars/${encodeURIComponent(calendarId)}/events`, { sendUpdates: input.sendUpdates }),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  );
}

/**
 * `events.patch`.
 *
 * A PATCH, not an update: a local edit changes the fields the editor showed, and replacing the whole
 * event would discard what another client set on a field Inboxora does not model.
 */
export async function patchGoogleEvent(
  options: GoogleApiOptions,
  calendarId: string,
  eventId: string,
  payload: GoogleEventWritePayload,
  input: { sendUpdates: GoogleSendUpdates },
): Promise<GoogleCalendarEvent | null> {
  return googleApiJson<GoogleCalendarEvent>(
    options,
    googleUrl(GOOGLE_CALENDAR_API_BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: input.sendUpdates }),
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  );
}

/** `events.delete`. Google answers `204`; a missing event answers `404` and is classified by the caller. */
export async function deleteGoogleEvent(
  options: GoogleApiOptions,
  calendarId: string,
  eventId: string,
  input: { sendUpdates: GoogleSendUpdates },
): Promise<void> {
  await googleApiVoid(
    options,
    googleUrl(GOOGLE_CALENDAR_API_BASE, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: input.sendUpdates }),
    { method: 'DELETE' },
  );
}

/** One event by its id — the series master, or an occurrence Google knows by its own id. */
export async function fetchGoogleEvent(options: GoogleApiOptions, calendarId: string, eventId: string): Promise<GoogleCalendarEvent | null> {
  const url = googleUrl(
    GOOGLE_CALENDAR_API_BASE,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {},
  );
  return await googleApiJson<GoogleCalendarEvent>(options, url);
}

/**
 * One series' **instances** in a window, which is how Google addresses a single occurrence.
 *
 * `singleEvents=false` on the ordinary listing returns the master and its modified instances, but not the
 * unmodified occurrences of a series, so an occurrence that has never been changed has no event of its own to
 * patch or delete. The instances endpoint is Google's own answer to that: it materialises every occurrence in
 * the window (including cancelled ones when `showDeleted=true`) and each carries the id a mutation needs —
 * `<masterId>_<originalStartUtc>` — together with `originalStartTime`, which is the value the local model
 * stores as the occurrence's `RECURRENCE-ID`.
 */
export async function fetchGoogleEventInstances(
  options: GoogleApiOptions,
  calendarId: string,
  masterId: string,
  input: { timeMin: string; timeMax: string; maxResults?: number },
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = googleUrl(
      GOOGLE_CALENDAR_API_BASE,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(masterId)}/instances`,
      {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        maxResults: input.maxResults ?? 250,
        showDeleted: true,
        singleEvents: true,
        pageToken,
      },
    );
    const body = await googleApiJson<{ items?: GoogleCalendarEvent[] | null; nextPageToken?: string | null }>(options, url);
    events.push(...(body?.items ?? []));
    pageToken = body?.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return events;
}

/** The local wall-clock date-time of an RFC 3339 stamp (`2026-09-01T09:00:00+02:00`). */
function wallClock(dateTime: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
  return match ? `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}` : null;
}

/** The iCalendar date/date-time value for one Google endpoint. */
function dateProperty(prefix: string, value: GoogleEventDateTime | null | undefined, defaultTimeZone: string | null): { line: string; zone: string | null; year: number | null } | null {
  if (!value) return null;
  if (value.date) {
    const date = value.date.replace(/-/g, '');
    if (!/^\d{8}$/.test(date)) return null;
    return { line: `${prefix};VALUE=DATE:${date}`, zone: null, year: Number(date.slice(0, 4)) };
  }
  if (!value.dateTime) return null;
  const local = wallClock(value.dateTime);
  if (!local) return null;
  const zone = isValidTimeZone(value.timeZone) ? value.timeZone : isValidTimeZone(defaultTimeZone) ? defaultTimeZone : null;
  if (zone) {
    return { line: `${prefix};TZID=${zone}:${local}`, zone, year: Number(local.slice(0, 4)) };
  }
  // No usable zone name: store the exact instant in UTC rather than a floating time.
  const instant = new Date(value.dateTime);
  if (Number.isNaN(instant.getTime())) return null;
  return { line: `${prefix}:${formatICalendarUtc(instant)}`, zone: null, year: instant.getUTCFullYear() };
}

const PARTSTAT: Record<string, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  needsAction: 'NEEDS-ACTION',
};

function personLine(name: 'ORGANIZER' | 'ATTENDEE', person: { email?: string | null; displayName?: string | null; responseStatus?: string | null; optional?: boolean | null }): string | null {
  const email = person.email?.trim();
  if (!email) return null;
  const parameters: string[] = [];
  if (person.displayName) parameters.push(`CN=${escapeICalendarParameter(person.displayName)}`);
  if (name === 'ATTENDEE') {
    const partstat = person.responseStatus ? PARTSTAT[person.responseStatus] : null;
    if (partstat) parameters.push(`PARTSTAT=${partstat}`);
    if (person.optional) parameters.push('ROLE=OPT-PARTICIPANT');
  }
  return `${name}${parameters.length ? `;${parameters.join(';')}` : ''}:mailto:${escapeICalendarText(email)}`;
}

interface VEventBuild {
  lines: string[];
  zones: Set<string>;
  startYear: number | null;
  recurring: boolean;
}

/**
 * Render one Google event as a VEVENT. `override` marks an instance of a series
 * (its `originalStartTime` becomes the RECURRENCE-ID).
 */
function buildVEventLines(event: GoogleCalendarEvent, input: { defaultTimeZone: string | null; override: boolean }): VEventBuild | null {
  const start = dateProperty('DTSTART', event.start, input.defaultTimeZone);
  const end = dateProperty('DTEND', event.end, input.defaultTimeZone);
  if (!start || !end) return null;
  const uid = event.iCalUID?.trim() || `${event.id}@google.com`;
  const zones = new Set<string>();
  if (start.zone) zones.add(start.zone);
  if (end.zone) zones.add(end.zone);

  const lines = ['BEGIN:VEVENT', `UID:${escapeICalendarText(uid)}`];
  const stamp = event.updated || event.created;
  const stampDate = stamp ? new Date(stamp) : new Date();
  lines.push(`DTSTAMP:${formatICalendarUtc(Number.isNaN(stampDate.getTime()) ? new Date() : stampDate)}`);
  if (typeof event.sequence === 'number' && event.sequence > 0) lines.push(`SEQUENCE:${event.sequence}`);

  if (input.override) {
    const original = dateProperty('RECURRENCE-ID', event.originalStartTime ?? event.start, input.defaultTimeZone);
    if (original) {
      lines.push(original.line);
      if (original.zone) zones.add(original.zone);
    }
  }

  lines.push(start.line, end.line);
  if (event.status === 'cancelled') lines.push('STATUS:CANCELLED');
  else if (event.status === 'tentative') lines.push('STATUS:TENTATIVE');
  if (event.summary) lines.push(`SUMMARY:${escapeICalendarText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeICalendarText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeICalendarText(event.location)}`);
  if (event.htmlLink) lines.push(`URL:${String(event.htmlLink).replace(/[\r\n]/g, '')}`);
  if (event.transparency === 'transparent') lines.push('TRANSP:TRANSPARENT');

  const organizer = event.organizer ? personLine('ORGANIZER', event.organizer) : null;
  if (organizer) lines.push(organizer);
  for (const attendee of event.attendees ?? []) {
    const line = personLine('ATTENDEE', attendee);
    if (line) lines.push(line);
  }

  // Google returns ready-to-use RRULE/EXDATE/RDATE lines (and only those).
  const recurrence = (event.recurrence ?? []).filter(line => /^(RRULE|EXDATE|RDATE)[;:]/i.test(line));
  for (const line of recurrence) lines.push(line.replace(/[\r\n]/g, ''));
  lines.push('END:VEVENT');

  return {
    lines,
    zones,
    startYear: start.year,
    recurring: recurrence.some(line => /^RRULE[;:]/i.test(line)),
  };
}

/** A whole VCALENDAR for a standalone event (no series). */
export function buildGoogleEventICalendar(event: GoogleCalendarEvent, input: { defaultTimeZone?: string | null } = {}): string | null {
  return buildGoogleSeriesICalendar({ master: event, overrides: [], defaultTimeZone: input.defaultTimeZone ?? null });
}

/**
 * One VCALENDAR holding a series: the master event plus its instance overrides.
 * Shared VTIMEZONEs are emitted once, covering the years the series can reach.
 * An override-only batch (an incremental sync that skipped the master) is allowed
 * and is meant to be merged into the stored resource.
 */
export function buildGoogleSeriesICalendar(input: {
  master?: GoogleCalendarEvent | null;
  overrides?: readonly GoogleCalendarEvent[];
  defaultTimeZone?: string | null;
}): string | null {
  const defaultTimeZone = isValidTimeZone(input.defaultTimeZone) ? input.defaultTimeZone : null;
  const master = input.master ? buildVEventLines(input.master, { defaultTimeZone, override: false }) : null;
  if (input.master && !master) return null;
  const overrides = (input.overrides ?? [])
    .map(event => buildVEventLines(event, { defaultTimeZone, override: true }))
    .filter((built): built is VEventBuild => built !== null);
  if (!master && overrides.length === 0) return null;

  const zones = new Set<string>(master?.zones ?? []);
  for (const built of overrides) for (const zone of built.zones) zones.add(zone);

  const startYear = master?.startYear ?? overrides[0]?.startYear ?? new Date().getUTCFullYear();
  // A series can run indefinitely, so cover a decade of transitions; a single
  // event (or an override batch) only needs the years around it.
  const recurring = master?.recurring ?? false;
  const yearWindow = recurring ? [startYear - 1, startYear + 10] : [startYear - 1, startYear + 1];
  const timezones: string[] = [];
  for (const zone of zones) {
    const block = buildVTimezone(zone, yearWindow[0], yearWindow[1]);
    if (block) timezones.push(block);
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inboxora//Google Calendar adapter//EN',
    ...timezones.flatMap(block => block.split('\r\n')),
    ...(master?.lines ?? []),
    ...overrides.flatMap(built => built.lines),
    'END:VCALENDAR',
    '',
  ];
  return lines.map(foldICalendarLine).join('\r\n');
}
