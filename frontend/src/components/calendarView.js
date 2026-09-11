import { richTextOrNull } from '../utils/richText.js';

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
  if (view !== 'month' && view !== 'agenda') {
    const next = new Date(anchor);
    next.setDate(next.getDate() + direction * 7);
    return next;
  }
  const year = anchor.getFullYear();
  const month = anchor.getMonth() + direction;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(anchor.getDate(), lastDay));
}

export function calendarVisibleRange(anchor, view, weekStartsOn = 1) {
  if (view === 'agenda') return monthRange(anchor);
  if (view !== 'month') return weekRange(anchor, weekStartsOn);
  const { start: monthStart } = monthRange(anchor);
  const { start } = weekRange(monthStart, weekStartsOn);
  const end = new Date(start);
  end.setDate(end.getDate() + 42);
  return { start, end };
}

// A week column grid is wider than a phone screen, so opening it at scrollLeft 0 would
// hide today behind a horizontal swipe. These two helpers pick the day to bring into
// view and work out where to scroll to, kept pure so the behaviour is testable without
// a browser.

/**
 * The index of the visible day a week/work-week grid should open on: today when the
 * shown week contains it, otherwise the selected day. `-1` when neither is visible
 * (for example a work-week that excludes a weekend anchor), meaning "leave it alone".
 */
export function weekFocusIndex(days, anchor, today = new Date()) {
  if (!Array.isArray(days) || !days.length) return -1;
  const todayIndex = days.findIndex(day => day.toDateString() === today.toDateString());
  if (todayIndex >= 0) return todayIndex;
  return days.findIndex(day => day.toDateString() === anchor?.toDateString());
}

/**
 * The scrollLeft that puts the middle of one column in the middle of the viewport,
 * clamped to the scrollable range. Returns 0 when the content already fits, so a wide
 * screen is unaffected.
 */
export function centeredScrollLeft({ columnStart, columnWidth, viewportWidth, contentWidth }) {
  if (![columnStart, columnWidth, viewportWidth, contentWidth].every(Number.isFinite)) return 0;
  const maxScroll = Math.max(0, contentWidth - viewportWidth);
  if (maxScroll <= 0) return 0;
  const target = columnStart + columnWidth / 2 - viewportWidth / 2;
  return Math.max(0, Math.min(maxScroll, Math.round(target)));
}

export function agendaDays(events, anchor) {
  const { start, end } = monthRange(anchor);
  const days = [];
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
    const entries = sortedDayEvents(events, day);
    if (entries.length) days.push({ day: new Date(day), events: entries });
  }
  return days;
}

export function sortedDayEvents(events, day) {
  return eventsForDay(events, day).sort((a, b) =>
    Number(Boolean(b.all_day || b.allDay)) - Number(Boolean(a.all_day || a.allDay)) ||
    parseEventDate(a.starts_at ?? a.startsAt) - parseEventDate(b.starts_at ?? b.startsAt) ||
    String(a.id).localeCompare(String(b.id)));
}

// Build a per-day lookup for a fixed event array.
//
// The month grid asks for 42 days on every render, and the week grid asks twice
// per visible day; re-filtering and re-sorting the whole event array each time
// repeated the same work (and re-parsed every date). This parses each event's
// dates once, then answers per-day queries from a cache, so a render costs one
// pass over the events plus one pass per distinct day. The predicate and the
// ordering are exactly those of eventsForDay/sortedDayEvents.
export function createDayEventsResolver(events) {
  const list = Array.isArray(events) ? events : [];
  const prepared = list.map(event => ({
    event,
    allDay: Boolean(event.all_day || event.allDay),
    startKey: String(event.starts_at ?? event.startsAt ?? '').slice(0, 10),
    endKey: String(event.ends_at ?? event.endsAt ?? '').slice(0, 10),
    startDate: parseEventDate(event.starts_at ?? event.startsAt),
    endDate: parseEventDate(event.ends_at ?? event.endsAt),
  }));
  const cache = new Map();
  return day => {
    const dayKey = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
    const cached = cache.get(dayKey);
    if (cached) return cached;
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const entries = [];
    for (const item of prepared) {
      if (item.allDay) {
        if (item.startKey <= dayKey && dayKey < item.endKey) entries.push(item);
      } else if (item.startDate < dayEnd && item.endDate > dayStart) entries.push(item);
    }
    entries.sort((a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      a.startDate - b.startDate ||
      String(a.event.id).localeCompare(String(b.event.id)));
    const result = entries.map(item => item.event);
    cache.set(dayKey, result);
    return result;
  };
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
    ...(form.recurrenceId ? { recurrenceId: form.recurrenceId } : {}),
    calendarId: form.calendarId,
    summary: form.summary.trim(),
    description: richTextOrNull(form.description),
    location: form.location.trim() || null,
    url: form.url.trim() || null,
    organizer: form.organizer.trim() || null,
    allDay: Boolean(form.allDay),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    startsAt,
    endsAt,
    attendees,
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
    return parseEventDate(event.starts_at ?? event.startsAt) < dayEnd && parseEventDate(event.ends_at ?? event.endsAt) > dayStart;
  });
}

function localDayStart(day) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function parseEventDate(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T24:00(?::00(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return new Date(value);
  const [, year, month, day, fraction = '', timezone] = match;
  if (!timezone) return new Date(Number(year), Number(month) - 1, Number(day) + 1);
  const nextDay = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1));
  return new Date(`${nextDay.toISOString().slice(0, 10)}T00:00${fraction ? `:00${fraction}` : ''}${timezone}`);
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

function localDayKey(day) {
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
}

// Whether the copy of an all-day event shown in one day continues from an earlier
// day or into a later one. The week grid draws these events as full-height bands, so
// the edges that join a neighbouring day are squared off instead of rounded, which
// makes a multi-day event read as one stretched block rather than separate chips.
export function allDayEventSegment(event, day) {
  const dayKey = localDayKey(day);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const startKey = String(event.starts_at ?? event.startsAt ?? '').slice(0, 10);
  const endKey = String(event.ends_at ?? event.endsAt ?? '').slice(0, 10);
  return { continuesFrom: startKey < dayKey, continuesTo: endKey > localDayKey(next) };
}

// Place every all-day event that covers `day`. Unlike timed events these all span
// the whole day, so they simply take one equal-width column each, which keeps two
// full-day events side by side instead of hiding one behind the other. The input is
// re-sorted by start then id so the same event keeps the same column on every day it
// covers, even though each day is laid out independently.
export function layoutAllDayEvents(events, day) {
  const dayKey = localDayKey(day);
  const covering = (Array.isArray(events) ? events : [])
    .filter(event => {
      if (!(event.all_day || event.allDay)) return false;
      const startKey = String(event.starts_at ?? event.startsAt ?? '').slice(0, 10);
      const endKey = String(event.ends_at ?? event.endsAt ?? '').slice(0, 10);
      return startKey <= dayKey && dayKey < endKey;
    })
    .sort((a, b) => {
      const startDifference = String(a.starts_at ?? a.startsAt ?? '').localeCompare(String(b.starts_at ?? b.startsAt ?? ''));
      return startDifference || String(a.id).localeCompare(String(b.id));
    });
  const columns = Math.max(1, covering.length);
  return covering.map((event, column) => ({ event, column, columns, ...allDayEventSegment(event, day) }));
}

// Range-maximum over a static array. The collision-group width below needs the
// peak overlap inside an interval; a sparse table answers each query in O(1)
// after O(n log n) construction. This replaces the previous nested scans, which
// were cubic in the number of simultaneously overlapping events.
function buildRangeMax(values) {
  const length = values.length;
  if (!length) return () => 0;
  const logs = new Array(length + 1).fill(0);
  for (let index = 2; index <= length; index += 1) logs[index] = logs[index >> 1] + 1;
  const table = [values.slice()];
  for (let level = 1; (1 << level) <= length; level += 1) {
    const previous = table[level - 1];
    const row = new Array(length - (1 << level) + 1);
    for (let index = 0; index < row.length; index += 1) {
      row[index] = Math.max(previous[index], previous[index + (1 << (level - 1))]);
    }
    table.push(row);
  }
  // `start` is inclusive, `end` exclusive.
  return (start, end) => {
    if (start >= end) return 0;
    const level = logs[end - start];
    return Math.max(table[level][start], table[level][end - (1 << level)]);
  };
}

// Intervals already placed in one column are pairwise disjoint, so they can be
// kept sorted by start (and therefore by end). That makes "does any of them
// overlap [start, end)?" a binary search: the last interval starting before
// `end` carries the largest end, so it alone decides the answer.
function columnOverlaps(columnIntervals, start, end) {
  let low = 0;
  let high = columnIntervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (columnIntervals[middle][0] < end) low = middle + 1;
    else high = middle;
  }
  return low > 0 && columnIntervals[low - 1][1] > start;
}

function insertByStart(columnIntervals, interval) {
  let low = 0;
  let high = columnIntervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (columnIntervals[middle][0] < interval[0]) low = middle + 1;
    else high = middle;
  }
  columnIntervals.splice(low, 0, interval);
}

// Lay timed events out in the day column.
//
// `column` keeps the original first-fit semantics: events are assigned in input
// order, and an event takes the lowest column index whose already-placed events
// do not overlap it. `columns` is the peak number of events overlapping at once
// inside the event's own interval — the collision-group width used to size each
// card. Both are computed without the nested scans the previous implementation
// used, which made assigning columns cubic in the number of overlapping events.
export function layoutTimedEvents(events, day) {
  const items = events.map(event => ({ event, geometry: eventGeometryForDay(event, day) })).filter(item => item.geometry);
  if (!items.length) return [];
  const columns = [];
  const placed = items.map(item => {
    const { start, end } = item.geometry;
    let column = 0;
    while (column < columns.length && columnOverlaps(columns[column], start, end)) column += 1;
    if (column === columns.length) columns.push([[start, end]]);
    else insertByStart(columns[column], [start, end]);
    return { ...item, column };
  });
  if (placed.length === 1) return placed.map(item => ({ ...item, columns: 1 }));
  const boundaries = [...new Set(placed.flatMap(item => [item.geometry.start, item.geometry.end]))].sort((left, right) => left - right);
  const boundaryIndex = new Map(boundaries.map((value, index) => [value, index]));
  // Concurrency is constant between adjacent boundaries, so a difference array
  // yields the peak overlap for every elementary interval in one pass.
  const delta = new Array(boundaries.length).fill(0);
  for (const item of placed) {
    delta[boundaryIndex.get(item.geometry.start)] += 1;
    delta[boundaryIndex.get(item.geometry.end)] -= 1;
  }
  const concurrency = new Array(Math.max(0, boundaries.length - 1));
  let running = 0;
  for (let index = 0; index < concurrency.length; index += 1) {
    running += delta[index];
    concurrency[index] = running;
  }
  const rangeMax = buildRangeMax(concurrency);
  return placed.map(item => ({
    ...item,
    columns: Math.max(1, rangeMax(boundaryIndex.get(item.geometry.start), boundaryIndex.get(item.geometry.end))),
  }));
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
