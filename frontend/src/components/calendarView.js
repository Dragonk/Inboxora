export function monthRange(anchor) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { start, end };
}

export function weekRange(anchor) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const weekday = (start.getDay() + 6) % 7;
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
