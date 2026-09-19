/**
 * VTIMEZONE generation from an IANA zone id (P09).
 *
 * A provider that returns JSON (Google, Graph) gives an instant plus a zone name,
 * not a VTIMEZONE. Storing the wall time with `TZID` but no VTIMEZONE would make
 * the exported iCalendar wrong for every client that cannot resolve IANA names
 * itself — and a recurring series would drift by an hour across a DST boundary.
 *
 * The transitions are read from the platform's own tz database through `Intl`, so
 * a rule change needs no code change here. Only the changed offsets and their
 * instants are emitted; TZNAME is omitted rather than guessed.
 */

import { foldICalendarLine } from './icalText.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_TRANSITIONS = 80;

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    // A bogus zone id throws on the first format, not on construction.
    formatter.format(new Date(0));
  } catch {
    formatter = null;
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  return typeof timeZone === 'string' && timeZone.length > 0 && formatterFor(timeZone) !== null;
}

/** Offset of `timeZone` at `instant`, in minutes east of UTC (null when unknown). */
export function zoneOffsetMinutes(timeZone: string, instant: Date): number | null {
  const formatter = formatterFor(timeZone);
  if (!formatter) return null;
  const parts = formatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  const second = value('second');
  if ([year, month, day, hour, minute, second].some(Number.isNaN)) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour % 24, minute, second);
  return Math.round((asUtc - instant.getTime()) / MINUTE_MS);
}

/** Minutes east of UTC as an iCalendar UTC offset (`+0200`, `-0430`, `+0000`). */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mins = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}${mins}`;
}

/** An instant expressed in a zone's wall clock, as a floating iCalendar date-time. */
function localDateTime(instant: Date, offsetMinutes: number): string {
  const local = new Date(instant.getTime() + offsetMinutes * MINUTE_MS);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(local.getUTCFullYear(), 4)}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
}

/** Narrow the exact transition instant between two probes known to differ. */
function transitionInstant(timeZone: string, before: number, after: number, beforeOffset: number): number {
  let low = before;
  let high = after;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2);
    if (zoneOffsetMinutes(timeZone, new Date(middle)) === beforeOffset) low = middle;
    else high = middle;
  }
  return high;
}

function fold(line: string): string {
  return foldICalendarLine(line);
}


export interface TimezoneTransition {
  at: Date;
  fromOffset: number;
  toOffset: number;
}

/** The offset changes of a zone between two instants, in order. */
export function zoneTransitions(timeZone: string, from: Date, to: Date): TimezoneTransition[] | null {
  if (!isValidTimeZone(timeZone)) return null;
  const transitions: TimezoneTransition[] = [];
  const start = from.getTime();
  const end = to.getTime();
  let previous = zoneOffsetMinutes(timeZone, new Date(start));
  if (previous === null) return null;
  for (let probe = start + HOUR_MS; probe <= end; probe += HOUR_MS) {
    const offset = zoneOffsetMinutes(timeZone, new Date(probe));
    if (offset === null) return null;
    if (offset !== previous) {
      const exact = transitionInstant(timeZone, probe - HOUR_MS, probe, previous);
      transitions.push({ at: new Date(exact), fromOffset: previous, toOffset: offset });
      previous = offset;
      if (transitions.length >= MAX_TRANSITIONS) break;
    }
  }
  return transitions;
}

/**
 * A VTIMEZONE block for `timeZone`, covering the given years inclusive. Returns
 * null for an unusable zone id so the caller can fall back to UTC instead of
 * writing a TZID it cannot define.
 */
export function buildVTimezone(timeZone: string, fromYear: number, toYear: number): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  const firstYear = Math.min(fromYear, toYear);
  const lastYear = Math.max(fromYear, toYear);
  const from = new Date(Date.UTC(firstYear, 0, 1));
  const to = new Date(Date.UTC(lastYear + 1, 0, 1));
  const transitions = zoneTransitions(timeZone, from, to);
  if (!transitions) return null;

  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
  const startOffset = zoneOffsetMinutes(timeZone, from) ?? 0;
  // A baseline at the start of the window: an expanding client (ical.js included)
  // looks for the last change at or before an instant, so without one a date
  // before the first transition would be read with a zero offset — an hour off.
  lines.push(
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${formatOffset(startOffset)}`,
    `TZOFFSETTO:${formatOffset(startOffset)}`,
    `DTSTART:${localDateTime(from, startOffset)}`,
    'END:STANDARD',
  );
  for (const transition of transitions) {
    const kind = transition.toOffset > transition.fromOffset ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      `TZOFFSETFROM:${formatOffset(transition.fromOffset)}`,
      `TZOFFSETTO:${formatOffset(transition.toOffset)}`,
      `DTSTART:${localDateTime(transition.at, transition.fromOffset)}`,
      `END:${kind}`,
    );
  }
  lines.push('END:VTIMEZONE');
  return lines.map(fold).join('\r\n');
}
