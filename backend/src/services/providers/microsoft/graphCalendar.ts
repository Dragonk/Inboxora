import { graphDelete, graphGet, graphPatch, graphPost, graphUrl, graphGetWithHeaders } from './graphApiClient.js';
import type { GraphApiOptions } from './graphApiClient.js';
import { buildVTimezone, isValidTimeZone } from '../../../utils/icalTimezone.js';
import {
  escapeICalendarParameter,
  escapeICalendarText,
  foldICalendarLine,
  formatICalendarUtc,
} from '../../../utils/icalText.js';

/**
 * Microsoft Graph **calendar** adapter (P07d).
 *
 * Like the Google calendar adapter, the local model and every DAV client read iCalendar, so a Graph
 * event is rendered into a VCALENDAR resource rather than stored as JSON. The two providers disagree in
 * ways that matter here and must be handled rather than papered over:
 *
 *  - Graph's recurrence is **structured** (`pattern` + `range`), not an RRULE line, so the rule is
 *    built and every pattern type it can express is mapped deliberately;
 *  - Graph's `dateTime` is a **wall time with a separate zone name**, not an offset stamp, so a DST
 *    boundary cannot shift a series only if a real VTIMEZONE is emitted alongside it;
 *  - a series is a `seriesMaster` with `occurrence`/`exception` instances carrying `seriesMasterId`,
 *    so the master and its overrides are merged into the one resource RFC 4791 requires;
 *  - permission is per calendar (`canEdit`), which is what makes a read-only collection a provider
 *    fact rather than an Inboxora preference.
 */

export const GRAPH_CALENDAR_PATH = '/me/calendars';
export const GRAPH_CALENDAR_SELECT = 'id,name,color,hexColor,isDefaultCalendar,canEdit,canShare,canViewPrivateItems,owner,changeKey';
export const GRAPH_EVENT_SELECT = [
  'id', 'iCalUId', 'subject', 'body', 'bodyPreview', 'start', 'end', 'isAllDay', 'isCancelled',
  'seriesMasterId', 'type', 'originalStart', 'recurrence', 'attendees', 'organizer', 'location',
  'locations', 'onlineMeetingUrl', 'webLink', 'responseStatus', 'showAs', 'sensitivity', 'importance',
  'createdDateTime', 'lastModifiedDateTime', 'changeKey',
].join(',');

/** One calendar as Graph returns it, narrowed to the fields this adapter reads. */
export interface GraphCalendar {
  id: string;
  name?: string | null;
  color?: string | null;
  hexColor?: string | null;
  isDefaultCalendar?: boolean | null;
  canEdit?: boolean | null;
  canShare?: boolean | null;
  canViewPrivateItems?: boolean | null;
  owner?: { name?: string | null; address?: string | null } | null;
  changeKey?: string | null;
}

export interface GraphDateTime {
  /** A wall-clock stamp with no offset, e.g. `2026-09-01T09:00:00.0000000`. */
  dateTime: string;
  timeZone?: string | null;
}

export interface GraphEmailAddress {
  address?: string | null;
  name?: string | null;
}

export interface GraphAttendee {
  emailAddress?: GraphEmailAddress | null;
  /** `none` | `organizer` | `tentative` | `accepted` | `declined` */
  status?: { response?: string | null; time?: string | null } | null;
  /** `required` | `optional` | `resource` */
  type?: string | null;
}

export interface GraphRecurrencePattern {
  /** `daily` | `weekly` | `absoluteMonthly` | `relativeMonthly` | `absoluteYearly` | `relativeYearly` */
  type: string;
  interval?: number | null;
  month?: number | null;
  dayOfMonth?: number | null;
  daysOfWeek?: string[] | null;
  firstDayOfWeek?: string | null;
  /** `first` | `second` | `third` | `fourth` | `last` */
  index?: string | null;
}

export interface GraphRecurrenceRange {
  /** `endDate` | `noEnd` | `numbered` */
  type: string;
  startDate?: string | null;
  endDate?: string | null;
  numberOfOccurrences?: number | null;
  recurrenceTimeZone?: string | null;
}

export interface GraphEvent {
  id: string;
  iCalUId?: string | null;
  subject?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  bodyPreview?: string | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  seriesMasterId?: string | null;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster' | null;
  /** The occurrence's original start; the `RECURRENCE-ID` of a moved instance. */
  originalStart?: string | null;
  recurrence?: { pattern?: GraphRecurrencePattern | null; range?: GraphRecurrenceRange | null } | null;
  attendees?: GraphAttendee[] | null;
  organizer?: { emailAddress?: GraphEmailAddress | null } | null;
  location?: { displayName?: string | null } | null;
  locations?: Array<{ displayName?: string | null }> | null;
  onlineMeetingUrl?: string | null;
  webLink?: string | null;
  responseStatus?: { response?: string | null } | null;
  showAs?: string | null;
  sensitivity?: string | null;
  importance?: string | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  changeKey?: string | null;
  '@removed'?: { reason?: string | null };
}

const DEFAULT_COLOR = '#0f6cbd';
/** Graph's named colours, as the hex values the local model stores. */
const NAMED_COLORS: Record<string, string> = {
  lightBlue: '#0f6cbd', lightGreen: '#1a7f37', lightOrange: '#c05621', lightGray: '#6b7280',
  lightYellow: '#b7791f', lightTeal: '#0e7490', lightPink: '#c2185b', lightRed: '#c62828',
  maxColor: '#0b5cab', auto: DEFAULT_COLOR,
};

export function graphCalendarColor(calendar: GraphCalendar): string {
  const hex = typeof calendar.hexColor === 'string' && /^#[0-9a-f]{6}$/i.test(calendar.hexColor) ? calendar.hexColor : null;
  if (hex) return hex;
  const named = calendar.color ? NAMED_COLORS[calendar.color] : undefined;
  return named ?? DEFAULT_COLOR;
}

/**
 * Whether the **provider** lets this calendar be written to.
 *
 * It is deliberately separate from Inboxora's own `read_only` column: a calendar the provider would
 * accept a write to is still pulled read-only until the user asks for write-back, and a calendar the
 * provider refuses to edit must never be offered as writable. `canEdit` absent is treated as "not
 * editable", because guessing in the permissive direction is how a refused write becomes a silent one.
 */
export function graphCalendarAllowsWrites(calendar: GraphCalendar): boolean {
  return calendar.canEdit === true;
}

export interface GraphCalendarPage {
  calendars: GraphCalendar[];
  nextLink: string | null;
}

/** One page of calendars. `link` is an absolute `@odata.nextLink` from a previous page. */
export async function fetchGraphCalendarsPage(api: GraphApiOptions, input: { link?: string | null; pageSize?: number } = {}): Promise<GraphCalendarPage> {
  const path = input.link
    ? input.link
    : graphUrl(GRAPH_CALENDAR_PATH, {
      $select: GRAPH_CALENDAR_SELECT,
      $top: Number.isFinite(input.pageSize) && Number(input.pageSize) > 0 ? Math.min(250, Math.floor(Number(input.pageSize))) : 100,
    });
  const body = await graphGet<{ value?: GraphCalendar[] | null; '@odata.nextLink'?: string | null }>(api, path);
  return {
    calendars: (Array.isArray(body.value) ? body.value : []).filter(calendar => Boolean(calendar?.id)),
    nextLink: body['@odata.nextLink'] ?? null,
  };
}

/** The mailbox's own calendar, which Graph exposes separately from the calendar list. */
export async function fetchGraphPrimaryCalendar(api: GraphApiOptions): Promise<GraphCalendar | null> {
  const body = await graphGet<GraphCalendar>(api, graphUrl('/me/calendar', { $select: GRAPH_CALENDAR_SELECT }));
  return body?.id ? body : null;
}

export interface GraphEventPage {
  events: GraphEvent[];
  nextLink: string | null;
  deltaLink: string | null;
}

/**
 * One page of a calendar's events, delta-shaped.
 *
 * `events/delta` returns the **masters** of recurring series plus `@removed` tombstones, which is what makes a
 * series reconcilable: `calendarView/delta` returns occurrences and exceptions instead and loses the master.
 * `link` carries an absolute `@odata.nextLink`/`@odata.deltaLink` forward, so a resumed run continues exactly
 * where the cursor said.
 *
 * The delta function accepts **neither `$select` nor `$top`** — Microsoft documents `$select`, `$expand`,
 * `$filter`, `$orderby` and `$search` as unsupported for the delta function on events and on a calendar view, and
 * paging is controlled with `Prefer: odata.maxpagesize`. Both were sent here, and the parameter combination
 * cannot work; the request now uses only what the contract allows.
 *
 * Still open (GRAPH-02): the item-delta form used here is documented as **beta-only**, while `calendarView/delta`
 * is available on v1.0 but returns occurrences and exceptions rather than the series master this projection
 * needs. Choosing between a beta read and a windowed redesign cannot be settled from the documentation alone and
 * needs a live tenant to validate, so the API version is deliberately left as it is rather than switched blind.
 */
export async function fetchGraphCalendarEventsPage(api: GraphApiOptions, calendarId: string, input: { link?: string | null; pageSize?: number } = {}): Promise<GraphEventPage> {
  const path = input.link
    ? input.link
    : graphUrl(`${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events/delta`, {});
  const pageSize = Number.isFinite(input.pageSize) && Number(input.pageSize) > 0 ? Math.min(250, Math.floor(Number(input.pageSize))) : 100;
  const body = await graphGetWithHeaders<{ value?: GraphEvent[] | null; '@odata.nextLink'?: string | null; '@odata.deltaLink'?: string | null }>(
    api,
    path,
    // `odata.maxpagesize` is how a delta round is paged; the timezone preference keeps an occurrence's identity
    // in the same frame the instances call uses.
    { prefer: `odata.maxpagesize=${pageSize}, outlook.timezone="UTC"` },
  );
  return {
    events: (Array.isArray(body.value) ? body.value : []).filter(event => Boolean(event?.id)),
    nextLink: body['@odata.nextLink'] ?? null,
    deltaLink: body['@odata.deltaLink'] ?? null,
  };
}

/**
 * The calendar's events, without delta semantics — used to look for one that a split may already have created.
 *
 * `events/delta` cannot answer that question: it answers from a cursor and advances it, and a recovery path must
 * not consume a synchronisation's round. This is the ordinary listing (masters included, which a calendar view
 * would not return), paged by its own `@odata.nextLink` and capped, because a recovery is rare and a bounded read
 * is better than an unbounded one. No `$filter` is sent: the syntax of a filter on a nested date property is not
 * something this codebase has validated against the service, and matching is done on what comes back.
 */
export async function listGraphCalendarEvents(api: GraphApiOptions, calendarId: string, input: { pageSize?: number; maxPages?: number } = {}): Promise<GraphEvent[]> {
  const pageSize = Number.isFinite(input.pageSize) && Number(input.pageSize) > 0 ? Math.min(250, Math.floor(Number(input.pageSize))) : 100;
  const events: GraphEvent[] = [];
  let link: string | null = graphUrl(`${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events`, { $top: pageSize });
  for (let page = 0; page < (input.maxPages ?? 5) && link; page += 1) {
    const body: { value?: GraphEvent[] | null; '@odata.nextLink'?: string | null } = await graphGet<{
      value?: GraphEvent[] | null; '@odata.nextLink'?: string | null;
    }>(api, link);
    for (const event of body.value ?? []) {
      if (event?.id) events.push(event);
    }
    link = body['@odata.nextLink'] ?? null;
  }
  return events;
}

export function graphEventIsCancelled(event: GraphEvent): boolean {
  return event.isCancelled === true || event['@removed'] !== undefined;
}

/** The series a group of events belongs to: an instance carries its master's id. */
export function graphEventGroupId(event: GraphEvent): string {
  return event.seriesMasterId?.trim() || event.id;
}

export function groupGraphEvents(events: readonly GraphEvent[]): Map<string, { master: GraphEvent | null; overrides: GraphEvent[] }> {
  const groups = new Map<string, { master: GraphEvent | null; overrides: GraphEvent[] }>();
  const ensure = (id: string) => {
    if (!groups.has(id)) groups.set(id, { master: null, overrides: [] });
    return groups.get(id)!;
  };
  for (const event of events) {
    const groupId = graphEventGroupId(event);
    const group = ensure(groupId);
    // A `seriesMasterId` marks an instance; the master itself has none. An `@removed` tombstone for a
    // master still lands in its own group so the resource is deleted rather than left behind.
    if (event.seriesMasterId) group.overrides.push(event);
    else group.master = event;
  }
  return groups;
}

const GRAPH_DAYS: Record<string, string> = {
  sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA',
};
const GRAPH_INDEX: Record<string, string> = { first: '1', second: '2', third: '3', fourth: '4', last: '-1' };

const graphDay = (value: unknown): string | null =>
  typeof value === 'string' ? GRAPH_DAYS[value.trim().toLowerCase()] ?? null : null;
const graphIndex = (value: unknown): string | null =>
  typeof value === 'string' ? GRAPH_INDEX[value.trim().toLowerCase()] ?? null : null;
const positiveInteger = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

/**
 * Build the `RRULE` for a Graph recurrence.
 *
 * Every pattern type Graph defines is mapped explicitly, and an unknown one returns `null` rather than a
 * half-built rule: a wrong RRULE silently changes when a meeting repeats, which is worse than a series
 * that is stored once and reported as skipped. `UNTIL` is emitted in UTC, as RFC 5545 requires when the
 * event's start carries a TZID.
 */
export function graphRecurrenceRule(
  pattern: GraphRecurrencePattern | null | undefined,
  range: GraphRecurrenceRange | null | undefined,
): string | null {
  if (!pattern?.type) return null;
  const parts: string[] = [];
  const interval = positiveInteger(pattern.interval);

  switch (pattern.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly': {
      parts.push('FREQ=WEEKLY');
      const days = (pattern.daysOfWeek ?? []).map(graphDay).filter((day): day is string => day !== null);
      if (!days.length) return null;
      parts.push(`BYDAY=${days.join(',')}`);
      break;
    }
    case 'absoluteMonthly': {
      const day = positiveInteger(pattern.dayOfMonth);
      if (day === null || day > 31) return null;
      parts.push('FREQ=MONTHLY', `BYMONTHDAY=${day}`);
      break;
    }
    case 'relativeMonthly': {
      const day = graphDay((pattern.daysOfWeek ?? [])[0]);
      if (!day) return null;
      // Graph's `index` is optional here; without it the rule means "every <day> of the month".
      const index = graphIndex(pattern.index);
      parts.push('FREQ=MONTHLY', `BYDAY=${index ? `${index}${day}` : day}`);
      break;
    }
    case 'absoluteYearly': {
      const month = positiveInteger(pattern.month);
      if (month === null || month > 12) return null;
      parts.push('FREQ=YEARLY', `BYMONTH=${month}`);
      const day = positiveInteger(pattern.dayOfMonth);
      if (day !== null && day <= 31) parts.push(`BYMONTHDAY=${day}`);
      break;
    }
    case 'relativeYearly': {
      const month = positiveInteger(pattern.month);
      const day = graphDay((pattern.daysOfWeek ?? [])[0]);
      if (month === null || month > 12 || !day) return null;
      const index = graphIndex(pattern.index);
      parts.push('FREQ=YEARLY', `BYMONTH=${month}`, `BYDAY=${index ? `${index}${day}` : day}`);
      break;
    }
    default:
      return null;
  }

  if (interval !== null && interval > 1) parts.push(`INTERVAL=${interval}`);
  if (pattern.type === 'weekly') {
    const wkst = graphDay(pattern.firstDayOfWeek);
    if (wkst) parts.push(`WKST=${wkst}`);
  }

  const rangeType = range?.type ?? 'noEnd';
  if (rangeType === 'numbered') {
    const count = positiveInteger(range?.numberOfOccurrences);
    if (count === null) return null;
    parts.push(`COUNT=${count}`);
  } else if (rangeType === 'endDate') {
    const match = typeof range?.endDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(range.endDate) : null;
    if (!match) return null;
    // The end date is inclusive, so the last occurrence is on that date.
    parts.push(`UNTIL=${match[1]}${match[2]}${match[3]}T235959Z`);
  }

  return `RRULE:${parts.join(';')}`;
}

/** The local wall-clock value of a Graph stamp (`2026-09-01T09:00:00.0000000`). */
function wallClock(dateTime: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
  return match ? `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}` : null;
}

interface DatePropertyBuild {
  line: string;
  zone: string | null;
  year: number | null;
}

/**
 * The iCalendar date/date-time value for one Graph endpoint.
 *
 * Graph gives a wall time plus a zone name, so `TZID=<zone>` is the faithful rendering (the VTIMEZONE is
 * emitted beside it). A UTC stamp is written with the `Z` form, and a stamp whose zone is unusable is
 * read as the instant Graph means rather than stored as a floating time that would drift.
 */
function dateProperty(
  prefix: string,
  value: GraphDateTime | null | undefined,
  defaultTimeZone: string | null,
  allDay: boolean,
): DatePropertyBuild | null {
  if (!value?.dateTime) return null;
  const local = wallClock(value.dateTime);
  if (!local) return null;
  if (allDay) return { line: `${prefix};VALUE=DATE:${local.slice(0, 8)}`, zone: null, year: Number(local.slice(0, 4)) };

  const zone = isValidTimeZone(value.timeZone) ? value.timeZone : isValidTimeZone(defaultTimeZone) ? defaultTimeZone : null;
  if (zone && zone !== 'UTC' && zone !== 'Etc/UTC') {
    return { line: `${prefix};TZID=${zone}:${local}`, zone, year: Number(local.slice(0, 4)) };
  }
  // No usable zone name: store the exact instant in UTC rather than a floating time.
  const instant = new Date(`${local.slice(0, 4)}-${local.slice(4, 6)}-${local.slice(6, 8)}T${local.slice(9, 11)}:${local.slice(11, 13)}:${local.slice(13, 15)}Z`);
  if (Number.isNaN(instant.getTime())) return null;
  return { line: `${prefix}:${formatICalendarUtc(instant)}`, zone: null, year: instant.getUTCFullYear() };
}

const PARTSTAT: Record<string, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  notResponded: 'NEEDS-ACTION',
  none: 'NEEDS-ACTION',
};

function personLine(name: 'ORGANIZER' | 'ATTENDEE', person: {
  address?: string | null;
  name?: string | null;
  response?: string | null;
  optional?: boolean;
}): string | null {
  const email = person.address?.trim();
  if (!email) return null;
  const parameters: string[] = [];
  if (person.name) parameters.push(`CN=${escapeICalendarParameter(person.name)}`);
  if (name === 'ATTENDEE') {
    const partstat = person.response ? PARTSTAT[person.response] : null;
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

/** Render one Graph event as a VEVENT. `override` marks an instance of a series. */
function buildVEventLines(event: GraphEvent, input: { defaultTimeZone: string | null; override: boolean }): VEventBuild | null {
  const allDay = event.isAllDay === true;
  const start = dateProperty('DTSTART', event.start, input.defaultTimeZone, allDay);
  const end = dateProperty('DTEND', event.end, input.defaultTimeZone, allDay);
  if (!start || !end) return null;
  const uid = event.iCalUId?.trim() || `${event.id}@microsoft.com`;
  const zones = new Set<string>();
  if (start.zone) zones.add(start.zone);
  if (end.zone) zones.add(end.zone);

  const lines = ['BEGIN:VEVENT', `UID:${escapeICalendarText(uid)}`];
  const modified = event.lastModifiedDateTime ?? event.createdDateTime;
  const modifiedDate = modified ? new Date(modified) : new Date();
  lines.push(`DTSTAMP:${formatICalendarUtc(Number.isNaN(modifiedDate.getTime()) ? new Date() : modifiedDate)}`);

  if (input.override) {
    const original = event.originalStart
      ? dateProperty('RECURRENCE-ID', { dateTime: event.originalStart, timeZone: event.start?.timeZone ?? null }, input.defaultTimeZone, allDay)
      : start;
    if (original) {
      lines.push(original.line);
      if (original.zone) zones.add(original.zone);
    }
  }

  lines.push(start.line, end.line);
  if (graphEventIsCancelled(event)) lines.push('STATUS:CANCELLED');
  if (event.subject) lines.push(`SUMMARY:${escapeICalendarText(event.subject)}`);
  const bodyContent = event.body?.content?.trim();
  if (bodyContent) {
    if (event.body?.contentType?.toLowerCase() === 'html') {
      lines.push(`X-ALT-DESC;FMTTYPE=text/html:${escapeICalendarText(bodyContent)}`);
      if (event.bodyPreview) lines.push(`DESCRIPTION:${escapeICalendarText(event.bodyPreview)}`);
    } else {
      lines.push(`DESCRIPTION:${escapeICalendarText(bodyContent)}`);
    }
  } else if (event.bodyPreview) {
    lines.push(`DESCRIPTION:${escapeICalendarText(event.bodyPreview)}`);
  }
  const location = event.location?.displayName?.trim()
    || (event.locations ?? []).map(entry => entry.displayName?.trim()).find(Boolean)
    || null;
  if (location) lines.push(`LOCATION:${escapeICalendarText(location)}`);
  const url = event.onlineMeetingUrl || event.webLink;
  if (url) lines.push(`URL:${String(url).replace(/[\r\n]/g, '')}`);
  // A free/busy hint is the one `showAs` value the wire format can carry.
  if (event.showAs === 'free') lines.push('TRANSP:TRANSPARENT');

  const organizer = event.organizer?.emailAddress
    ? personLine('ORGANIZER', { address: event.organizer.emailAddress.address, name: event.organizer.emailAddress.name })
    : null;
  if (organizer) lines.push(organizer);
  for (const attendee of event.attendees ?? []) {
    const line = personLine('ATTENDEE', {
      address: attendee.emailAddress?.address,
      name: attendee.emailAddress?.name,
      response: attendee.status?.response ?? null,
      optional: attendee.type === 'optional',
    });
    if (line) lines.push(line);
  }

  const rule = graphRecurrenceRule(event.recurrence?.pattern, event.recurrence?.range);
  if (rule) lines.push(rule);
  lines.push('END:VEVENT');

  return {
    lines,
    zones,
    startYear: start.year,
    recurring: rule !== null,
  };
}

/** A whole VCALENDAR for a standalone event (no series). */
export function buildGraphEventICalendar(event: GraphEvent, input: { defaultTimeZone?: string | null } = {}): string | null {
  return buildGraphSeriesICalendar({ master: event, overrides: [], defaultTimeZone: input.defaultTimeZone ?? null });
}

/**
 * One VCALENDAR holding a series: the master event plus its instance overrides.
 *
 * Shared VTIMEZONEs are emitted once, covering the years the series can reach. An override-only batch —
 * an incremental delta that changed one instance and not the master — is allowed and is meant to be
 * merged into the stored resource.
 */
export function buildGraphSeriesICalendar(input: {
  master?: GraphEvent | null;
  overrides?: readonly GraphEvent[];
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
    'PRODID:-//Inboxora//Microsoft Graph adapter//EN',
    ...timezones.flatMap(block => block.split('\r\n')),
    ...(master?.lines ?? []),
    ...overrides.flatMap(built => built.lines),
    'END:VCALENDAR',
    '',
  ];
  return lines.map(foldICalendarLine).join('\r\n');
}

/**
 * The Graph event payload a create or patch sends.
 *
 * `transactionId` is deliberately the caller's own idempotency key: Graph rejects a repeated create with
 * the same transaction id instead of producing a second event, which is what lets a retried create be
 * safe. `responseRequested` is omitted because changing it is not part of creating an event.
 */
export interface GraphEventPayload {
  subject: string;
  start: GraphDateTime;
  end: GraphDateTime;
  isAllDay?: boolean;
  body?: { contentType: 'Text' | 'HTML'; content: string };
  location?: { displayName: string };
  attendees?: GraphAttendee[];
  recurrence?: { pattern: GraphRecurrencePattern; range: GraphRecurrenceRange } | null;
  showAs?: string;
  transactionId?: string;
}

export async function createGraphEvent(api: GraphApiOptions, calendarId: string, payload: GraphEventPayload): Promise<GraphEvent | null> {
  return graphPost<GraphEvent>(api, `${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events`, payload);
}

export async function patchGraphEvent(api: GraphApiOptions, calendarId: string, eventId: string, payload: Partial<GraphEventPayload>): Promise<GraphEvent | null> {
  return graphPatch<GraphEvent>(api, `${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, payload);
}

export async function deleteGraphEvent(api: GraphApiOptions, calendarId: string, eventId: string): Promise<void> {
  await graphDelete(api, `${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

/**
 * One series' **instances** in a window, which is how Graph addresses a single occurrence.
 *
 * A series' unmodified occurrences are not returned by the ordinary event listing — only the `seriesMaster`
 * and its `exception` instances are — so an occurrence nobody has changed has no id of its own to patch or
 * delete. `/instances` materialises them, each carrying the id a mutation needs and `originalStart`, the
 * occurrence's own start that the local model stores as its `RECURRENCE-ID`. `Prefer: outlook.timezone="UTC"`
 * is sent so the returned times are in one frame regardless of the mailbox's zone.
 */
export async function fetchGraphEventInstances(
  api: GraphApiOptions,
  calendarId: string,
  masterId: string,
  input: { startDateTime: string; endDateTime: string; top?: number },
): Promise<GraphEvent[]> {
  const events: GraphEvent[] = [];
  let link: string | null = graphUrl(
    `${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(masterId)}/instances`,
    {
      startDateTime: input.startDateTime,
      endDateTime: input.endDateTime,
      '$top': input.top ?? 100,
      '$select': 'id,subject,start,end,isAllDay,type,seriesMasterId,originalStart,recurrence,attendees,isCancelled',
    },
  );
  for (let page = 0; page < 20 && link; page++) {
    const body: { value?: GraphEvent[] | null; '@odata.nextLink'?: string | null } =
      await graphGetWithHeaders(api, link, { prefer: 'outlook.timezone="UTC"' });
    events.push(...(body.value ?? []));
    link = body['@odata.nextLink'] ?? null;
  }
  return events;
}

export async function fetchGraphEvent(api: GraphApiOptions, calendarId: string, eventId: string): Promise<GraphEvent | null> {
  return graphGet<GraphEvent>(api, graphUrl(`${GRAPH_CALENDAR_PATH}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { $select: GRAPH_EVENT_SELECT }));
}
