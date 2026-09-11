import ICAL from 'ical.js';
import { calendarZoneResolver, calendarDescription, parseCalendarEvent, parseICalendarDate } from './ical.js';

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
function wallClockMs(time) {
  const year = Number(time?.year);
  // Years below 100 (and malformed values) cannot be inside a modern window and
  // Date.UTC would remap them into the 1900s anyway.
  if (!Number.isFinite(year) || year < 100) return Number.NEGATIVE_INFINITY;
  return Date.UTC(year, time.month - 1, time.day, time.hour || 0, time.minute || 0, time.second || 0);
}

export function calendarResources(raw) {
  const root = new ICAL.Component(ICAL.parse(raw));
  if (root.name !== 'vcalendar' || !/^END:VCALENDAR\s*$/im.test(raw)) throw new Error('Invalid calendar document');
  const groups = new Map();
  for (const event of root.getAllSubcomponents('vevent')) {
    const uid = event.getFirstPropertyValue('uid');
    // Keep malformed objects separate so the importer can report them.
    const key = uid || Symbol();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()].map(events => {
    const calendar = new ICAL.Component('vcalendar');
    calendar.addPropertyWithValue('version', '2.0');
    for (const zone of root.getAllSubcomponents('vtimezone')) calendar.addSubcomponent(new ICAL.Component(structuredClone(zone.toJSON())));
    for (const event of events) calendar.addSubcomponent(new ICAL.Component(structuredClone(event.toJSON())));
    return calendar.toString();
  });
}

function dateOf(time, property, zoneFor) {
  const value = time.toICALString();
  const parameters = time.isDate ? { VALUE: 'DATE' } : value.endsWith('Z') ? {} : { TZID: property?.getParameter('tzid') || time.zone?.tzid };
  return parseICalendarDate({ value, parameters }, zoneFor)?.date;
}

export function projectCalendarResource(row, from, to) {
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
export function projectCalendarResourceWithStatus(row, from, to, options = {}) {
  const { raw_ical, ...metadata } = row;
  const maxIterations = Number.isFinite(options.maxIterations) && options.maxIterations > 0
    ? Math.floor(options.maxIterations)
    : DEFAULT_MAX_ITERATIONS;
  const deadline = Number.isFinite(options.deadline) ? options.deadline : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const status = { events: [], truncated: false, reason: null };
  if (!raw_ical) { status.events = [metadata]; return status; }
  let root;
  try { root = new ICAL.Component(ICAL.parse(raw_ical)); } catch { status.events = [metadata]; return status; }
  const components = root.getAllSubcomponents('vevent');
  const master = components.find(component => !component.hasProperty('recurrence-id'));
  const base = master || components[0];
  if (!base) { status.events = [metadata]; return status; }
  const zoneFor = calendarZoneResolver(raw_ical, root);
  const recurring = master && (master.hasProperty('rrule') || master.hasProperty('rdate'));
  const event = new ICAL.Event(base);
  const result = [];
  const seen = new Set();
  const fromTime = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const toTime = to instanceof Date ? to.getTime() : new Date(to).getTime();
  const append = (details, recurrenceId) => {
    const component = details.item.component;
    if (String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const startsAt = dateOf(details.startDate, component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    const endsAt = dateOf(details.endDate, component.getFirstProperty('dtend') || component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    if (!startsAt || !endsAt || startsAt.getTime() >= toTime || endsAt.getTime() <= fromTime || seen.has(recurrenceId)) return;
    seen.add(recurrenceId);
    result.push({ ...metadata,
      ...(recurring ? { id: `${row.id}@${recurrenceId}`, series_id: row.id, recurrence_id: recurrenceId, recurring: true } : {}),
      summary: component.getFirstPropertyValue('summary') ?? metadata.summary,
      description: calendarDescription(component) ?? calendarDescription(base) ?? metadata.description,
      location: component.getFirstPropertyValue('location') ?? metadata.location,
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
  let iterator;
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
  } catch (error) {
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

// Replace editor-owned properties while retaining recurrence, alarms, extension
// fields, and other instances in the DAV resource.
export function mergeCalendarResource(raw, replacementRaw, recurrenceId = null, cancel = false) {
  if (!raw) return replacementRaw;
  const root = new ICAL.Component(ICAL.parse(raw));
  const replacement = new ICAL.Component(ICAL.parse(replacementRaw)).getFirstSubcomponent('vevent');
  const master = root.getAllSubcomponents('vevent').find(event => !event.hasProperty('recurrence-id'));
  if (!master) return replacementRaw;
  let target = master;
  if (recurrenceId) {
    const id = ICAL.Time.fromString(recurrenceId);
    target = root.getAllSubcomponents('vevent').find(event => event.getFirstPropertyValue('recurrence-id')?.toString() === recurrenceId);
    if (!target) {
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

export function calendarProjection(raw) {
  const event = parseCalendarEvent(raw);
  if (!event) throw new Error('Invalid calendar event');
  return event;
}
