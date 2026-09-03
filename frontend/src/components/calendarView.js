export function monthRange(anchor) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { start, end };
}

export function weekRange(anchor, weekStartsOn = 1) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const normalizedWeekStartsOn = weekStartsOn === 0 ? 0 : 1;
  const weekday = (start.getDay() - normalizedWeekStartsOn + 7) % 7;
  start.setDate(start.getDate() - weekday);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export function shiftCalendarAnchor(anchor, view, direction) {
  if (view !== 'month') {
    const next = new Date(anchor);
    next.setDate(next.getDate() + direction * 7);
    return next;
  }
  const year = anchor.getFullYear();
  const month = anchor.getMonth() + direction;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(anchor.getDate(), lastDay));
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

export function toggleAllDayTimes(form, allDay) {
  const toDate = value => String(value || '').slice(0, 10);
  const toDateTime = value => {
    const date = toDate(value);
    return date ? `${date}T00:00` : '';
  };
  return {
    ...form,
    allDay,
    startsAt: allDay ? toDate(form.startsAt) : toDateTime(form.startsAt),
    endsAt: allDay ? toDate(form.endsAt) : toDateTime(form.endsAt),
  };
}

export function eventPayload(form) {
  const dateOnlyToIso = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString();
  };
  const startsAt = form.allDay ? dateOnlyToIso(form.startsAt) : fromDateTimeLocal(form.startsAt);
  const endsAt = form.allDay ? dateOnlyToIso(form.endsAt) : fromDateTimeLocal(form.endsAt);
  if (!form.calendarId || !startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) return null;
  const attendees = Array.isArray(form.attendees) ? form.attendees.map(value => value.trim()).filter(Boolean) : [];
  const sendInvites = Boolean(form.sendInvites);
  if (sendInvites && (!form.inviteAccountId || !attendees.length)) return null;
  return {
    calendarId: form.calendarId,
    summary: form.summary.trim(),
    description: form.description.trim() || null,
    location: form.location.trim() || null,
    url: form.url.trim() || null,
    organizer: form.organizer.trim() || null,
    allDay: Boolean(form.allDay),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    startsAt,
    endsAt,
    attendees: sendInvites ? attendees : [],
    sendInvites,
    inviteAccountId: sendInvites ? form.inviteAccountId : null,
  };
}

export function eventsForDay(events, day) {
  const dayKey = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  return events.filter(event => {
    if (event.all_day || event.allDay) {
      const start = String(event.starts_at ?? event.startsAt ?? '').slice(0, 10);
      const end = String(event.ends_at ?? event.endsAt ?? '').slice(0, 10);
      return start <= dayKey && dayKey < end;
    }
    return new Date(event.starts_at) < dayEnd && new Date(event.ends_at) > dayStart;
  });
}

function localDayStart(day) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function parseEventDate(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T24:00(?::00(?:\.000)?)?(?:Z)?$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1) : new Date(value);
}

export function eventGeometryForDay(event, day) {
  if (event.all_day || event.allDay) return null;
  const dayStart = localDayStart(day);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const starts = parseEventDate(event.starts_at ?? event.startsAt);
  const ends = parseEventDate(event.ends_at ?? event.endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= dayStart || starts >= dayEnd) return null;
  const start = Math.max(0, Math.round((starts - dayStart) / 60000));
  const end = Math.min(1440, Math.round((ends - dayStart) / 60000));
  return { start, end: Math.max(start + 1, end) };
}

export function layoutTimedEvents(events, day) {
  const items = events.map(event => ({ event, geometry: eventGeometryForDay(event, day) })).filter(item => item.geometry);
  const placed = [];
  for (const item of items) {
    let column = 0;
    while (placed.some(other => other.column === column && other.geometry.start < item.geometry.end && other.geometry.end > item.geometry.start)) column += 1;
    placed.push({ ...item, column });
  }
  return placed.map(item => {
    const overlaps = placed.filter(other => other.geometry.start < item.geometry.end && other.geometry.end > item.geometry.start);
    const points = [...new Set(overlaps.flatMap(other => [Math.max(other.geometry.start, item.geometry.start), Math.min(other.geometry.end, item.geometry.end)]))].sort((a, b) => a - b);
    const columns = Math.max(...points.slice(0, -1).map((point, index) => overlaps.filter(other => other.geometry.start <= point && other.geometry.end > point && other.geometry.start < points[index + 1]).length), 1);
    return { ...item, columns };
  });
}

export function workHoursGeometry(start = '09:00', end = '17:00') {
  const toMinutes = value => {
    const [hours, minutes] = String(value || '').split(':').map(Number);
    return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  };
  const startMinutes = Math.max(0, Math.min(1440, toMinutes(start)));
  const endMinutes = Math.max(startMinutes, Math.min(1440, toMinutes(end)));
  return { start: startMinutes, end: endMinutes };
}
