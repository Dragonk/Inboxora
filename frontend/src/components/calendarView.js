export function monthRange(anchor) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { start, end };
}

export function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function eventPayload(form) {
  const startsAt = fromDateTimeLocal(form.startsAt);
  const endsAt = fromDateTimeLocal(form.endsAt);
  if (!form.calendarId || !startsAt || !endsAt || new Date(endsAt) < new Date(startsAt)) return null;
  return { calendarId: form.calendarId, summary: form.summary.trim(), description: form.description.trim() || null, location: form.location.trim() || null, url: form.url.trim() || null, organizer: form.organizer.trim() || null, allDay: Boolean(form.allDay), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null, startsAt, endsAt };
}

export function eventsForDay(events, day) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  return events.filter(event => new Date(event.starts_at) < dayEnd && new Date(event.ends_at) > dayStart);
}
