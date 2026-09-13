import ICAL from 'ical.js';
import { calendarZoneResolver, calendarDescription, parseCalendarEvent, parseICalendarDate } from './ical.js';
import type { ZoneResolver } from './ical.js';
import { toAppError } from '../utils/errors.js';
/**
 * The shipped ical.js type definitions omit the `Time.fromString` static although the
 * runtime provides it (verified against ical.js 2.2). This narrow, documented view
 * keeps call sites type-checked without a blanket cast.
 */
const TimeFromString = ICAL.Time as unknown as {
  fromString(value: string): InstanceType<typeof ICAL.Time>;
};



// Hard ceiling for one resource's recurrence walk. Reaching it is reported as a
// truncated (partial) projection, never as a silent omission.
export const DEFAULT_MAX_ITERATIONS = 100000;

// Real UTC offsets span roughly −12h..+14h, so a wall-clock reading can be up to
// 14h behind or 12h ahead of the actual instant. These margins make the
// wall-clock pre-filter below conservative in both directions.
const MAX_BEHIND_UTC_OFFSET_MS = 14 * 60 * 60 * 1000;
const MAX_AHEAD_UTC_OFFSET_MS = 12 * 60 * 60 * 1000;

// Wall-clock fields as epoch-like milliseconds, with no time-zone lookup. Used
// only for a conservative window pre-filter, never for the projected value.
function wallClockMs(time: ICAL.Time): number {
  const year = Number(time?.year);
  // Years below 100 (and malformed values) cannot be inside a modern window and
  // Date.UTC would remap them into the 1900s anyway.
  if (!Number.isFinite(year) || year < 100) return Number.NEGATIVE_INFINITY;
  return Date.UTC(year, time.month - 1, time.day, time.hour || 0, time.minute || 0, time.second || 0);
}

export function calendarResources(raw: string): string[] {
  const root = new ICAL.Component(ICAL.parse(raw));
  if (root.name !== 'vcalendar' || !/^END:VCALENDAR\s*$/im.test(raw)) throw new Error('Invalid calendar document');
  const groups = new Map<string | symbol, ICAL.Component[]>();
  for (const event of root.getAllSubcomponents('vevent')) {
    const uid = event.getFirstPropertyValue('uid');
    // Keep malformed objects separate so the importer can report them.
    const key: string | symbol = typeof uid === 'string' && uid ? uid : Symbol();
    const existing = groups.get(key);
    if (existing) existing.push(event);
    else groups.set(key, [event]);
  }
  return [...groups.values()].map(events => {
    const calendar = new ICAL.Component('vcalendar');
    calendar.addPropertyWithValue('version', '2.0');
    for (const zone of root.getAllSubcomponents('vtimezone')) calendar.addSubcomponent(new ICAL.Component(structuredClone(zone.toJSON())));
    for (const event of events) calendar.addSubcomponent(new ICAL.Component(structuredClone(event.toJSON())));
    return calendar.toString();
  });
}

function dateOf(time: ICAL.Time, property: ICAL.Property | null | undefined, zoneFor?: ZoneResolver): Date | null {
  const value = time.toICALString();
  const paramTzid = property?.getParameter('tzid');
  const zoneTzid = time.zone?.tzid;
  const tzid: string | undefined = typeof paramTzid === 'string' && paramTzid ? paramTzid : (typeof zoneTzid === 'string' ? zoneTzid : undefined);
  const parameters: Record<string, string | undefined> = time.isDate ? { VALUE: 'DATE' } : value.endsWith('Z') ? {} : { TZID: tzid };
  return parseICalendarDate({ value, parameters }, zoneFor)?.date ?? null;
}

export function projectCalendarResource(row: ProjectedEvent & { raw_ical?: string | null }, from: Date | string, to: Date | string): ProjectedEvent[] {
  return projectCalendarResourceWithStatus(row, from, to).events;
}

// Project one calendar resource into the requested window.
//
// The rule is always expanded from the series origin. Re-seeding
// `event.iterator(windowStart)` rewrites the rule's dtstart: it resets the
// INTERVAL phase, re-anchors MONTHLY/YEARLY rules to the window's day, drops the
// time-of-day and TZID, and turns DATE series into DATE-TIME. All of those shift
// or drop user-visible occurrences, so the projection walks from the original
// DTSTART and filters by the window instead. The CPU cost of that walk is moved
// off the request thread (see calendarProjectionPool.js) and amortised by the
// window projection cache.
//
// `options.maxIterations` bounds the walk; `options.deadline` (epoch ms) and
// `options.shouldAbort` let a caller stop an over-budget series. Any stop is
// reported as `truncated` with a reason, so a partial result is never silently
// presented as complete. `options.fullScan` disables the conservative
// wall-clock pre-filter; it exists so tests can prove the fast path is
// occurrence-equivalent to a full scan.
export interface ProjectOptions {
  maxIterations?: number;
  deadline?: number;
  shouldAbort?: () => boolean;
  fullScan?: boolean;
}

export interface ProjectedEvent {
  id?: string;
  starts_at?: Date;
  ends_at?: Date;
  summary?: string | null;
  description?: string | null;
  all_day?: boolean;
  [key: string]: unknown;
}

export interface ProjectStatus {
  events: ProjectedEvent[];
  truncated: boolean;
  reason: string | null;
  error?: string;
}

export function projectCalendarResourceWithStatus(row: ProjectedEvent & { raw_ical?: string | null }, from: Date | string, to: Date | string, options: ProjectOptions = {}) {
  const { raw_ical, ...metadata } = row;
  const requestedIterations = Number(options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const maxIterations = Number.isFinite(requestedIterations) && requestedIterations > 0
    ? Math.floor(requestedIterations)
    : DEFAULT_MAX_ITERATIONS;
  const requestedDeadline = Number(options.deadline);
  const deadline = Number.isFinite(requestedDeadline) ? requestedDeadline : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const status: ProjectStatus = { events: [], truncated: false, reason: null };
  if (!raw_ical) { status.events = [metadata]; return status; }
  let root: ICAL.Component;
  try { root = new ICAL.Component(ICAL.parse(raw_ical)); } catch { status.events = [metadata]; return status; }
  const components = root.getAllSubcomponents('vevent');
  const master = components.find(component => !component.hasProperty('recurrence-id'));
  const base = master || components[0];
  if (!base) { status.events = [metadata]; return status; }
  const zoneFor = calendarZoneResolver(raw_ical, root);
  const recurring = master && (master.hasProperty('rrule') || master.hasProperty('rdate'));
  const event = new ICAL.Event(base);
  const result: ProjectedEvent[] = [];
  const seen = new Set<string>();
  const fromTime = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const toTime = to instanceof Date ? to.getTime() : new Date(to).getTime();
  const append = (details: { item: ICAL.Event; startDate: ICAL.Time; endDate: ICAL.Time }, recurrenceId: string): void => {
    const component = details.item.component;
    if (String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const startsAt = dateOf(details.startDate, component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    const endsAt = dateOf(details.endDate, component.getFirstProperty('dtend') || component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    if (!startsAt || !endsAt || startsAt.getTime() >= toTime || endsAt.getTime() <= fromTime || seen.has(recurrenceId)) return;
    seen.add(recurrenceId);
    result.push({ ...metadata,
      ...(recurring ? { id: `${row.id}@${recurrenceId}`, series_id: row.id, recurrence_id: recurrenceId, recurring: true } : {}),
      summary: (component.getFirstPropertyValue('summary') as string | null) ?? metadata.summary ?? null,
      description: calendarDescription(component) ?? calendarDescription(base) ?? metadata.description,
      location: (component.getFirstPropertyValue('location') as string | null) ?? metadata.location ?? null,
      url: component.getFirstPropertyValue('url') ?? metadata.url,
      organizer: String(component.getFirstPropertyValue('organizer') || metadata.organizer || '').replace(/^mailto:/i, '') || null,
      attendees: component.hasProperty('attendee') ? component.getAllProperties('attendee').map(property => String(property.getFirstValue()).replace(/^mailto:/i, '')) : metadata.attendees || [],
      starts_at: startsAt, ends_at: endsAt, all_day: details.startDate.isDate,
    });
  };
  if (!recurring) {
    append({ item: event, startDate: event.startDate, endDate: event.endDate }, '');
    status.events = result;
    return status;
  }
  let iterator: ReturnType<ICAL.Event['iterator']>;
  try { iterator = event.iterator(); } catch { status.events = result; status.truncated = true; status.reason = 'iterator-failed'; return status; }
  // Walking from the series origin is required for correctness, so the walk must
  // be cheap. Converting an occurrence to a JS Date costs a time-zone lookup,
  // while deciding "this is still far before the window" only needs the
  // wall-clock fields. Comparing wall-clock against the window with the widest
  // real UTC offsets (±14h / −12h) as a margin is conservative: an occurrence is
  // only skipped or the loop only stops when it is provably outside the window.
  // Occurrences near the boundary still take the precise path below.
  const fastForward = options.fullScan !== true && !(event.rangeExceptions?.length);
  const baseDurationMs = Math.max(0, (event.endDate.toUnixTime() - event.startDate.toUnixTime()) * 1000);
  let iterations = 0;
  try {
    for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
      if (++iterations > maxIterations) { status.truncated = true; status.reason = 'iteration-limit'; break; }
      // Checking the budget every 64 steps keeps the hot loop cheap while still
      // bounding a runaway rule to a bounded amount of extra work.
      if ((iterations & 63) === 0) {
        if (deadline !== null && Date.now() > deadline) { status.truncated = true; status.reason = 'deadline'; break; }
        if (shouldAbort && shouldAbort()) { status.truncated = true; status.reason = 'aborted'; break; }
      }
      if (fastForward) {
        const wall = wallClockMs(occurrence);
        if (wall - MAX_BEHIND_UTC_OFFSET_MS >= toTime) break;
        if (wall + MAX_AHEAD_UTC_OFFSET_MS + baseDurationMs <= fromTime) continue;
      } else {
        const instant = dateOf(occurrence, base.getFirstProperty('dtstart'), zoneFor);
        if (instant && instant.getTime() >= toTime) break;
      }
      append(event.getOccurrenceDetails(occurrence), occurrence.toString());
    }
  } catch (caught) {
    const error = toAppError(caught);
    // A malformed rule must not discard occurrences already projected for this
    // resource; the caller's per-resource isolation records the failure.
    status.truncated = true;
    status.reason = 'rule-error';
    status.error = error instanceof Error ? error.message : String(error);
  }
  // An exception may be moved into this view from an occurrence after its end.
  for (const exception of components.filter(component => component.hasProperty('recurrence-id'))) {
    try {
      const item = new ICAL.Event(exception);
      append({ item, startDate: item.startDate, endDate: item.endDate }, item.recurrenceId.toString());
    } catch { /* one damaged exception must not drop the rest of the resource */ }
  }
  status.events = result;
  return status;
}

// End a recurring series just before the given occurrence, which is what "cancel this and every
// following occurrence" means.
//
// The obvious implementation — an exception with `RECURRENCE-ID;RANGE=THISANDFUTURE` and
// `STATUS:CANCELLED` — was measured and does nothing here: ical.js applies a range exception in
// order to *reschedule* the tail (a THISANDFUTURE exception that moves one occurrence to 14:00
// moved every later one, which is correct), but a cancelled range exception left the series
// completely unchanged. Truncating the rule with UNTIL is also what other calendars write for
// this operation, so the result stays portable instead of depending on one reader's extension.
//
// Returns `{ raw, empty }` — `empty` means the cut removed every occurrence (the caller asked
// to cancel from the series' own first instance), in which case the event should be deleted
// rather than left behind as a series that produces nothing. Null when there is nothing to
// truncate: not a series, or the resource no longer parses.
export function truncateSeriesBefore(raw: string | null | undefined, recurrenceId: string): { raw: string; empty: boolean } | null {
  if (!raw) return null;
  let root: ICAL.Component;
  try { root = new ICAL.Component(ICAL.parse(raw)); } catch { return null; }
  const master = root.getAllSubcomponents('vevent').find(event => !event.hasProperty('recurrence-id'));
  if (!master) return null;
  const rule = master.getFirstPropertyValue('rrule') as ICAL.Recur | null;
  if (!rule) return null;

  const dtstartProperty = master.getFirstProperty('dtstart');
  const id = TimeFromString.fromString(recurrenceId);
  const zoneFor = calendarZoneResolver(raw, root);
  // The recurrence id is a bare local time, so it only becomes an instant through the series'
  // own time zone — the same resolution the projection uses.
  const startDate = dateOf(id, dtstartProperty, zoneFor);
  if (!startDate) return null;

  // Cutting at the series' first occurrence leaves no occurrences at all.
  const seriesStart = dateOf(master.getFirstPropertyValue('dtstart') as ICAL.Time, dtstartProperty, zoneFor);
  const empty = seriesStart !== null && seriesStart.getTime() >= startDate.getTime();

  const until = id.isDate
    // A date-valued series needs a date-valued UNTIL, or ical.js compares a DATE against a
    // DATE-TIME and the boundary occurrence survives. ICAL.Time.fromString wants the dashed
    // form for a DATE, not the compact one.
    ? TimeFromString.fromString(new Date(startDate.getTime() - 1000).toISOString().slice(0, 10))
    : ICAL.Time.fromJSDate(new Date(startDate.getTime() - 1000), true);
  rule.until = until;
  master.updatePropertyWithValue('rrule', rule);

  // Exceptions at or after the cut describe occurrences the series no longer produces.
  const cutoff = startDate.getTime();
  for (const event of root.getAllSubcomponents('vevent')) {
    if (!event.hasProperty('recurrence-id')) continue;
    const exceptionDate = dateOf(event.getFirstPropertyValue('recurrence-id') as ICAL.Time, dtstartProperty, zoneFor);
    if (exceptionDate && exceptionDate.getTime() >= cutoff) root.removeSubcomponent(event);
  }
  return { raw: root.toString(), empty };
}

// Replace editor-owned properties while retaining recurrence, alarms, extension
// fields, and other instances in the DAV resource.
export function mergeCalendarResource(raw: string | null | undefined, replacementRaw: string, recurrenceId: string | null = null, cancel = false): string {
  if (!raw) return replacementRaw;
  const root = new ICAL.Component(ICAL.parse(raw));
  const replacement = new ICAL.Component(ICAL.parse(replacementRaw)).getFirstSubcomponent('vevent');
  if (!replacement) return replacementRaw;
  const master = root.getAllSubcomponents('vevent').find(event => !event.hasProperty('recurrence-id'));
  if (!master) return replacementRaw;
  let target: ICAL.Component = master;
  if (recurrenceId) {
    const id = TimeFromString.fromString(recurrenceId);
    const existingException = root.getAllSubcomponents('vevent').find(event => event.getFirstPropertyValue('recurrence-id')?.toString() === recurrenceId);
    if (existingException) {
      target = existingException;
    } else {
      target = new ICAL.Component(structuredClone(master.toJSON()));
      for (const field of ['rrule', 'rdate', 'exdate']) target.removeAllProperties(field);
      const property = new ICAL.Property('recurrence-id');
      property.setValue(id);
      const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid');
      if (tzid && !id.isDate) property.setParameter('tzid', tzid);
      target.addProperty(property); root.addSubcomponent(target);
    }
  }
  for (const field of ['dtstart', 'dtend', 'duration', 'summary', 'description', 'location', 'url', 'organizer', 'attendee', 'dtstamp']) {
    target.removeAllProperties(field);
    for (const property of replacement.getAllProperties(field)) target.addProperty(new ICAL.Property(structuredClone(property.toJSON())));
  }
  if (cancel) target.updatePropertyWithValue('status', 'CANCELLED');
  else if (target.getFirstPropertyValue('status') === 'CANCELLED') target.removeAllProperties('status');
  return root.toString();
}

export function calendarProjection(raw: string): ReturnType<typeof parseCalendarEvent> {
  const event = parseCalendarEvent(raw);
  if (!event) throw new Error('Invalid calendar event');
  return event;
}
