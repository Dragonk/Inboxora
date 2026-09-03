import crypto from 'crypto';

export const FEED_TOKEN_BYTES = 32;

export function issueCalendarFeedToken() {
  const token = crypto.randomBytes(FEED_TOKEN_BYTES).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

export function hashCalendarFeedToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    .replaceAll('\n', '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function fold(line) {
  const result = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > 75 && current) {
      result.push(current); current = char;
    } else current += char;
  }
  result.push(current);
  return result.join('\r\n ');
}

function dateValue(value, allDay) {
  const date = new Date(value);
  const iso = date.toISOString();
  return allDay ? iso.slice(0, 10).replaceAll('-', '') : iso.replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
}

export function serializeCalendarFeed(events, calendarName = 'Inboxora') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inboxora//Calendar Feed//EN', `X-WR-CALNAME:${escapeText(calendarName)}`];
  for (const event of events) {
    const allDay = Boolean(event.all_day);
    lines.push('BEGIN:VEVENT', `UID:${escapeText(event.uid || event.id)}`, `DTSTAMP:${dateValue(event.updated_at || event.created_at || event.starts_at, false)}`, `DTSTART${allDay ? ';VALUE=DATE' : ''}:${dateValue(event.starts_at, allDay)}`, `DTEND${allDay ? ';VALUE=DATE' : ''}:${dateValue(event.ends_at, allDay)}`);
    if (event.summary) lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(fold).join('\r\n');
}
