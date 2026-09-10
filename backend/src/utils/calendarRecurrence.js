import ICAL from 'ical.js';
import { calendarZoneResolver, calendarDescription, parseCalendarEvent, parseICalendarDate } from './ical.js';

export function calendarResources(raw) {
  const root = new ICAL.Component(ICAL.parse(raw));
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
  const { raw_ical, ...metadata } = row;
  if (!raw_ical) return [metadata];
  let root;
  try { root = new ICAL.Component(ICAL.parse(raw_ical)); } catch { return [metadata]; }
  const components = root.getAllSubcomponents('vevent');
  const master = components.find(component => !component.hasProperty('recurrence-id'));
  const base = master || components[0];
  if (!base) return [metadata];
  const zoneFor = calendarZoneResolver(raw_ical);
  const recurring = master && (master.hasProperty('rrule') || master.hasProperty('rdate'));
  const event = new ICAL.Event(base);
  const result = [];
  const seen = new Set();
  const append = (details, recurrenceId) => {
    const component = details.item.component;
    if (String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const startsAt = dateOf(details.startDate, component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    const endsAt = dateOf(details.endDate, component.getFirstProperty('dtend') || component.getFirstProperty('dtstart') || base.getFirstProperty('dtstart'), zoneFor);
    if (!startsAt || !endsAt || startsAt >= to || endsAt <= from || seen.has(recurrenceId)) return;
    seen.add(recurrenceId);
    result.push({ ...metadata,
      ...(recurring ? { id: `${row.id}@${recurrenceId}`, series_id: row.id, recurrence_id: recurrenceId, recurring: true } : {}),
      summary: component.getFirstPropertyValue('summary') ?? metadata.summary,
      description: calendarDescription(component) ?? metadata.description,
      location: component.getFirstPropertyValue('location') ?? metadata.location,
      url: component.getFirstPropertyValue('url') ?? metadata.url,
      organizer: String(component.getFirstPropertyValue('organizer') || metadata.organizer || '').replace(/^mailto:/i, '') || null,
      attendees: component.hasProperty('attendee') ? component.getAllProperties('attendee').map(property => String(property.getFirstValue()).replace(/^mailto:/i, '')) : metadata.attendees || [],
      starts_at: startsAt, ends_at: endsAt, all_day: details.startDate.isDate,
    });
  };
  if (!recurring) {
    append({ item: event, startDate: event.startDate, endDate: event.endDate }, '');
    return result;
  }
  // Iterate from the series origin: starting a COUNT rule at the view's start
  // would incorrectly extend it. This cap also bounds hostile per-second rules.
  const iterator = event.iterator();
  let iterations = 0;
  for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
    if (++iterations > 100000) throw new Error('Calendar recurrence exceeds the supported expansion limit');
    const instant = dateOf(occurrence, base.getFirstProperty('dtstart'), zoneFor);
    if (instant && instant >= to) break;
    append(event.getOccurrenceDetails(occurrence), occurrence.toString());
  }
  // An exception may be moved into this view from an occurrence after its end.
  for (const exception of components.filter(component => component.hasProperty('recurrence-id'))) {
    const item = new ICAL.Event(exception);
    append({ item, startDate: item.startDate, endDate: item.endDate }, item.recurrenceId.toString());
  }
  return result;
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
