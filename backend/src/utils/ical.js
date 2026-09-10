import { Parser } from 'htmlparser2';
import ICAL from 'ical.js';

export function calendarZoneResolver(raw) {
  let component;
  return tzid => {
    try {
      component ??= new ICAL.Component(ICAL.parse(raw));
      const definition = component.getAllSubcomponents('vtimezone').find(zone => zone.getFirstPropertyValue('tzid') === tzid);
      // An empty context cannot define an offset; use Intl for known IANA IDs.
      if (!definition?.getAllSubcomponents().some(child => ['standard', 'daylight'].includes(child.name))) return null;
      return new ICAL.Timezone({ component: definition, tzid });
    } catch { return null; }
  };
}

function unfoldICalendarLines(raw) {
  const lines = [];
  for (const physicalLine of raw.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(physicalLine) && lines.length) lines[lines.length - 1] += physicalLine.slice(1);
    else if (physicalLine) lines.push(physicalLine);
  }
  return lines;
}

export function propertyFromLine(line) {
  let quoted = false;
  let separator = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ':' && !quoted) { separator = i; break; }
  }
  if (separator < 1) return null;
  const [name, ...parameterParts] = line.slice(0, separator).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const parameters = Object.fromEntries(parameterParts.map((part) => {
    const parameterSeparator = part.indexOf('=');
    if (parameterSeparator < 1) return [part.toUpperCase(), ''];
    return [part.slice(0, parameterSeparator).toUpperCase(), part.slice(parameterSeparator + 1).replace(/^"|"$/g, '')];
  }));
  return { name: name.toUpperCase(), parameters, value: line.slice(separator + 1) };
}

function unescapeICalendarText(value) {
  return value.replace(/\\([\\;,nN])/g, (_match, escaped) => (escaped.toLowerCase() === 'n' ? '\n' : escaped));
}

function utcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? date : null;
}

function timeZoneParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  } catch {
    return null;
  }
}

function localDateInTimeZone(year, month, day, hour, minute, second, timeZone) {
  const wallTime = utcDate(year, month, day, hour, minute, second);
  if (!wallTime) return null;
  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = timeZoneParts(instant, timeZone);
    if (!parts) return null;
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
    instant = new Date(wallTime.getTime() - offset);
  }
  const resolved = timeZoneParts(instant, timeZone);
  return resolved && resolved.year === year && resolved.month === month && resolved.day === day
    && resolved.hour === hour && resolved.minute === minute && resolved.second === second ? instant : null;
}

export function parseUtc(value) {
  if (!/^\d{8}T\d{6}Z$/.test(value || '')) return null;
  return utcDate(Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8)), Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)));
}

export function parseICalendarDate(property, zoneFor) {
  const { value, parameters } = property;
  const dateOnly = parameters.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
  if (dateOnly) {
    if (!/^\d{8}$/.test(value)) return null;
    const date = utcDate(Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8)));
    return date && { date, allDay: true, timeZone: null };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match || (parameters.VALUE && parameters.VALUE.toUpperCase() !== 'DATE-TIME')) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  if (utc) {
    if (parameters.TZID) return null;
    const date = utcDate(...numeric);
    return date && { date, allDay: false, timeZone: null };
  }
  const timeZone = parameters.TZID;
  if (!timeZone) return null;
  if (!utcDate(...numeric)) return null;
  let date;
  const zone = zoneFor?.(timeZone);
  if (zone) {
    try {
      const [year, month, day, hour, minute, second] = numeric;
      date = ICAL.Time.fromData({ year, month, day, hour, minute, second }, zone).toJSDate();
    } catch { return null; }
  } else date = localDateInTimeZone(...numeric, timeZone);
  return date && { date, allDay: false, timeZone };
}

function parseDuration(value) {
  const match = value.match(/^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/);
  if (!match) return null;
  const milliseconds = ((Number(match[1] || 0) * 7 + Number(match[2] || 0)) * 24 * 60 * 60
    + Number(match[3] || 0) * 60 * 60 + Number(match[4] || 0) * 60 + Number(match[5] || 0)) * 1000;
  return milliseconds > 0 ? milliseconds : null;
}

export function parseCalendarEvent(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 * 1024) return null;
  const lines = unfoldICalendarLines(raw);
  const componentLines = lines.map((line) => line.toUpperCase());
  const starts = componentLines.filter((line) => line === 'BEGIN:VEVENT');
  const ends = componentLines.filter((line) => line === 'END:VEVENT');
  const start = componentLines.indexOf('BEGIN:VEVENT');
  const end = componentLines.indexOf('END:VEVENT');
  if (starts.length > 1 && starts.length === ends.length) {
    try {
      const root = new ICAL.Component(ICAL.parse(raw));
      const events = root.getAllSubcomponents('vevent');
      const uid = events[0]?.getFirstPropertyValue('uid');
      if (!uid || events.some(event => event.getFirstPropertyValue('uid') !== uid) || events.filter(event => !event.hasProperty('recurrence-id')).length > 1) return null;
      const master = events.find(event => !event.hasProperty('recurrence-id')) || events[0];
      for (const event of events) if (event !== master) root.removeSubcomponent(event);
      const parsed = parseCalendarEvent(root.toString());
      return parsed && { ...parsed, raw };
    } catch { return null; }
  }
  if (starts.length !== 1 || ends.length !== 1 || start < 0 || end <= start) return null;
  // VALARM and other nested components may carry their own DTSTART/SUMMARY.
  let depth = 0;
  const properties = lines.slice(start + 1, end).filter(line => {
    if (/^BEGIN:/i.test(line)) { depth++; return false; }
    if (/^END:/i.test(line)) { depth--; return false; }
    return depth === 0;
  }).map(propertyFromLine);
  const zoneFor = calendarZoneResolver(raw);
  // Recurrence, alarms, attendees and other standard properties remain in the
  // raw object for round-trip interoperability. The normalized row is the
  // base-event projection. Recurrence information is retained in the resource.
  if (properties.some((property) => !property)) return null;
  const named = (name) => properties.filter((property) => property.name === name);
  const [uid] = named('UID');
  const [startProperty] = named('DTSTART');
  const [endProperty] = named('DTEND');
  const [durationProperty] = named('DURATION');
  if (!uid || !uid.value.trim() || named('UID').length !== 1 || !startProperty || named('DTSTART').length !== 1
    || named('DTEND').length > 1 || named('DURATION').length > 1 || (endProperty && durationProperty)) return null;
  const startsAt = parseICalendarDate(startProperty, zoneFor);
  if (!startsAt) return null;
  let endsAt;
  if (endProperty) {
    endsAt = parseICalendarDate(endProperty, zoneFor);
    if (!endsAt || endsAt.allDay !== startsAt.allDay) return null;
  } else if (durationProperty) {
    const duration = parseDuration(durationProperty.value);
    if (!duration || (startsAt.allDay && duration % (24 * 60 * 60 * 1000))) return null;
    endsAt = { date: new Date(startsAt.date.getTime() + duration), allDay: startsAt.allDay };
  } else if (startsAt.allDay) {
    endsAt = { date: new Date(startsAt.date.getTime() + 24 * 60 * 60 * 1000), allDay: true, timeZone: null };
  } else return null;
  if (endsAt.date <= startsAt.date) return null;
  const [summary] = named('SUMMARY');
  return {
    uid: uid.value,
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    allDay: startsAt.allDay,
    timeZone: startsAt.timeZone,
    summary: summary ? unescapeICalendarText(summary.value) : null,
    description: named('DESCRIPTION')[0] ? unescapeICalendarText(named('DESCRIPTION')[0].value) : (() => { try { return calendarDescription(new ICAL.Component(ICAL.parse(raw)).getFirstSubcomponent('vevent')); } catch { return null; } })(),
    location: named('LOCATION')[0] ? unescapeICalendarText(named('LOCATION')[0].value) : null,
    url: named('URL')[0]?.value || null,
    organizer: named('ORGANIZER')[0]?.value.replace(/^mailto:/i, '') || null,
    attendees: named('ATTENDEE').map(property => property.value.replace(/^mailto:/i, '')),
    raw,
  };
}


export function calendarDescription(component) {
  const plain = component.getFirstPropertyValue('description');
  if (plain) return plain;
  const html = component.getAllProperties('x-alt-desc').find(property => String(property.getParameter('fmttype')).toLowerCase() === 'text/html')?.getFirstValue();
  if (!html) return plain || null;
  let suppressed = 0;
  let text = '';
  const parser = new Parser({
    onopentag(name) { if (['script', 'style'].includes(name)) suppressed++; if (name === 'br' && !suppressed) text += '\n'; },
    ontext(value) { if (!suppressed) text += value; },
    onclosetag(name) { if (['script', 'style'].includes(name)) suppressed = Math.max(0, suppressed - 1); if (['p', 'div', 'li'].includes(name) && !suppressed) text += '\n'; },
  }, { decodeEntities: true });
  parser.end(String(html));
  return text.trim() || null;
}
