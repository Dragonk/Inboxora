const MAX_ICAL_BYTES = 1024 * 1024;

function unfoldLines(raw) {
  const lines = [];
  for (const physicalLine of raw.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(physicalLine) && lines.length) lines[lines.length - 1] += physicalLine.slice(1);
    else if (physicalLine) lines.push(physicalLine);
  }
  return lines;
}

function propertyFromLine(line) {
  const separator = line.indexOf(':');
  if (separator < 1) return null;
  const [name, ...parameterParts] = line.slice(0, separator).split(';');
  const parameters = Object.fromEntries(parameterParts.map((part) => {
    const parameterSeparator = part.indexOf('=');
    if (parameterSeparator < 1) return [part.toUpperCase(), ''];
    return [part.slice(0, parameterSeparator).toUpperCase(), part.slice(parameterSeparator + 1).replace(/^"|"$/g, '')];
  }));
  return { name: name.toUpperCase(), parameters, value: line.slice(separator + 1) };
}

function componentMarker(line) {
  const match = line.match(/^(BEGIN|END):([A-Z0-9-]+)$/i);
  return match && { type: match[1].toUpperCase(), name: match[2].toUpperCase() };
}

function calendarStructure(lines) {
  const stack = [];
  const calendarLines = [];
  const eventLines = [];
  let eventCount = 0;
  for (const line of lines) {
    const marker = componentMarker(line);
    if (marker) {
      if (marker.type === 'BEGIN') {
        if (!stack.length && marker.name !== 'VCALENDAR') return null;
        if (stack.length === 1 && marker.name === 'VEVENT') eventCount++;
        stack.push(marker.name);
      } else if (stack.pop() !== marker.name) return null;
      continue;
    }
    if (stack.length === 1 && stack[0] === 'VCALENDAR') calendarLines.push(line);
    else if (stack.length === 2 && stack[0] === 'VCALENDAR' && stack[1] === 'VEVENT') eventLines.push(line);
  }
  return stack.length === 0 && eventCount === 1 ? { calendarLines, eventLines } : null;
}

function unescapeText(value) {
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
  const offsets = new Set();
  for (let hours = -18; hours <= 18; hours++) {
    const instant = new Date(wallTime.getTime() + hours * 60 * 60 * 1000);
    const parts = timeZoneParts(instant, timeZone);
    if (!parts) return null;
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime());
  }
  const candidates = [...offsets].map(offset => new Date(wallTime.getTime() - offset)).filter((instant) => {
    const resolved = timeZoneParts(instant, timeZone);
    return resolved && resolved.year === year && resolved.month === month && resolved.day === day
      && resolved.hour === hour && resolved.minute === minute && resolved.second === second;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function parseDate(property) {
  const { value, parameters } = property;
  const allDay = parameters.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
  if (allDay) {
    if (!/^\d{8}$/.test(value)) return null;
    const date = utcDate(Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8)));
    return date && { date, allDay: true, timeZone: null, form: 'date' };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match || parameters.VALUE) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  if (utc) return parameters.TZID ? null : (() => {
    const date = utcDate(...numeric);
    return date && { date, allDay: false, timeZone: null, form: 'utc' };
  })();
  const timeZone = parameters.TZID;
  if (!timeZone) return null;
  const date = localDateInTimeZone(...numeric, timeZone);
  return date && { date, allDay: false, timeZone, form: 'timezone' };
}

function isoRecurrenceId(property) {
  const parsed = parseDate(property);
  return parsed ? parsed.date.toISOString().replace(/[-:]/g, '').replace('.000', '') : null;
}

export function parseInboundCalendarInvitation(raw) {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw, 'utf8') > MAX_ICAL_BYTES) return null;
  const lines = unfoldLines(raw);
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.at(-1)?.toUpperCase() !== 'END:VCALENDAR') return null;
  const structure = calendarStructure(lines);
  if (!structure) return null;
  const calendarProperties = structure.calendarLines.map(propertyFromLine);
  const eventProperties = structure.eventLines.map(propertyFromLine);
  if (calendarProperties.some(property => !property) || eventProperties.some(property => !property)) return null;
  const named = (properties, name) => properties.filter(property => property.name === name);
  const [method] = named(calendarProperties, 'METHOD');
  const acceptedMethods = new Set(['REQUEST', 'CANCEL']);
  const normalizedMethod = method?.value.trim().toUpperCase();
  if (!acceptedMethods.has(normalizedMethod) || named(calendarProperties, 'METHOD').length !== 1) return null;

  const [uid] = named(eventProperties, 'UID');
  const [start] = named(eventProperties, 'DTSTART');
  const [end] = named(eventProperties, 'DTEND');
  const [stamp] = named(eventProperties, 'DTSTAMP');
  const [sequence] = named(eventProperties, 'SEQUENCE');
  const [summary] = named(eventProperties, 'SUMMARY');
  const [organizer] = named(eventProperties, 'ORGANIZER');
  const [recurrenceId] = named(eventProperties, 'RECURRENCE-ID');
  if (!uid || !uid.value.trim() || named(eventProperties, 'UID').length !== 1) return null;
  const sequenceValue = sequence ? Number(sequence.value) : 0;
  if ((sequence && !/^\d+$/.test(sequence.value)) || !Number.isSafeInteger(sequenceValue) || sequenceValue < 0 || named(eventProperties, 'SEQUENCE').length > 1) return null;
  const recurrenceValue = recurrenceId ? isoRecurrenceId(recurrenceId) : '';
  if (recurrenceId && (!recurrenceValue || named(eventProperties, 'RECURRENCE-ID').length !== 1)) return null;

  if (normalizedMethod === 'CANCEL') {
    if (eventProperties.some(property => !['UID', 'SEQUENCE', 'RECURRENCE-ID'].includes(property.name))) return null;
    return {
      method: normalizedMethod, state: 'cancelled', uid: uid.value, recurrenceId: recurrenceValue, sequence: sequenceValue,
      summary: null, organizer: null, startsAt: null, endsAt: null,
      allDay: null, timeZone: null, raw,
    };
  }

  const stampDate = stamp && parseDate(stamp);
  const attendees = named(eventProperties, 'ATTENDEE');
  if (!stamp || named(eventProperties, 'DTSTAMP').length !== 1 || stampDate?.form !== 'utc' || !organizer || named(eventProperties, 'ORGANIZER').length !== 1 || !organizer.value.trim()) return null;
  if (!start || named(eventProperties, 'DTSTART').length !== 1 || !end || named(eventProperties, 'DTEND').length !== 1 || !attendees.length || attendees.some(attendee => !attendee.value.trim())) return null;
  const startsAt = parseDate(start);
  const endsAt = parseDate(end);
  if (!startsAt || !endsAt || startsAt.form !== endsAt.form || startsAt.timeZone !== endsAt.timeZone || endsAt.date <= startsAt.date) return null;
  if (recurrenceId) {
    const recurrenceDate = parseDate(recurrenceId);
    if (!recurrenceDate || recurrenceDate.form !== startsAt.form || recurrenceDate.timeZone !== startsAt.timeZone) return null;
  }

  return {
    method: normalizedMethod,
    state: 'pending',
    uid: uid.value,
    recurrenceId: recurrenceValue,
    sequence: sequenceValue,
    summary: summary ? unescapeText(summary.value) : null,
    organizer: organizer?.value || null,
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    allDay: startsAt.allDay,
    timeZone: startsAt.timeZone,
    raw,
  };
}
