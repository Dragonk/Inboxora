/**
 * Validation and rendering for the recurrence rule the calendar editor submits.
 *
 * The client never sends a raw RRULE: it sends a closed, structured object and
 * the server renders the RRULE. That keeps the stored rule inside the subset the
 * editor can round-trip and prevents an arbitrary property (or a newline) from
 * reaching the iCalendar body through this field.
 */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceInput {
  frequency: RecurrenceFrequency;
  interval: number;
  /** 0 = Sunday … 6 = Saturday (JavaScript's `getDay`), weekly only. */
  byWeekday: number[];
  until: string | null;
  count: number | null;
}

const FREQUENCIES: readonly RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const ALLOWED_KEYS = new Set(['frequency', 'interval', 'byWeekday', 'until', 'count']);
const MAX_INTERVAL = 999;
const MAX_COUNT = 1000;

export function isRecurrenceFrequency(value: unknown): value is RecurrenceFrequency {
  return typeof value === 'string' && (FREQUENCIES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validWeekday(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

/** Render an ISO instant as an iCalendar UTC date-time (UNTTIL for a timed series). */
function formatUntilDateTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Render an all-day UNTIL as a DATE, which is what a date-valued DTSTART requires. */
function formatUntilDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}${month}${day}`;
}

export type RecurrenceParseResult =
  | { ok: true; rrule: string | null }
  | { ok: false; error: string };

/**
 * Parse an untrusted `recurrence` field. `null`/`undefined` (and an explicit
 * `{ frequency: 'none' }`) means "not recurring". `allDay` selects the UNTIL
 * value type, because a date-valued series rejects a DATE-TIME bound.
 */
export function parseRecurrenceInput(value: unknown, options: { allDay: boolean }): RecurrenceParseResult {
  if (value === undefined || value === null) return { ok: true, rrule: null };
  if (!isPlainObject(value)) return { ok: false, error: 'recurrence must be an object' };
  const rawFrequency = value.frequency;
  if (rawFrequency === 'none' || rawFrequency === undefined) return { ok: true, rrule: null };
  if (!isRecurrenceFrequency(rawFrequency)) {
    return { ok: false, error: 'recurrence.frequency must be none, daily, weekly, monthly or yearly' };
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown recurrence field: ${key}` };
  }

  const rawInterval = value.interval;
  const interval = rawInterval === undefined || rawInterval === null ? 1 : Number(rawInterval);
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) {
    return { ok: false, error: `recurrence.interval must be an integer from 1 to ${MAX_INTERVAL}` };
  }

  let byWeekday: number[] = [];
  if (value.byWeekday !== undefined && value.byWeekday !== null) {
    if (rawFrequency !== 'weekly') return { ok: false, error: 'recurrence.byWeekday is only valid for a weekly series' };
    if (!Array.isArray(value.byWeekday) || value.byWeekday.length === 0 || value.byWeekday.length > 7 || !value.byWeekday.every(validWeekday)) {
      return { ok: false, error: 'recurrence.byWeekday must be 1-7 weekday numbers from 0 (Sunday) to 6 (Saturday)' };
    }
    byWeekday = [...new Set(value.byWeekday.map(Number))].sort((left, right) => left - right);
  }

  const hasUntil = value.until !== undefined && value.until !== null && value.until !== '';
  const hasCount = value.count !== undefined && value.count !== null && value.count !== '';
  if (hasUntil && hasCount) return { ok: false, error: 'recurrence cannot set both until and count' };

  let until: string | null = null;
  if (hasUntil) {
    if (typeof value.until !== 'string') return { ok: false, error: 'recurrence.until must be a date string' };
    until = options.allDay ? formatUntilDate(value.until) : formatUntilDateTime(value.until);
    if (!until) return { ok: false, error: 'recurrence.until must be a valid date' };
  }

  let count: number | null = null;
  if (hasCount) {
    count = Number(value.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return { ok: false, error: `recurrence.count must be an integer from 1 to ${MAX_COUNT}` };
    }
  }

  const parts = [`FREQ=${rawFrequency.toUpperCase()}`];
  if (interval !== 1) parts.push(`INTERVAL=${interval}`);
  if (byWeekday.length) parts.push(`BYDAY=${byWeekday.map(day => WEEKDAY_CODES[day]).join(',')}`);
  if (until) parts.push(`UNTIL=${until}`);
  if (count) parts.push(`COUNT=${count}`);
  return { ok: true, rrule: parts.join(';') };
}

/** The rule shape returned to the editor when it opens an existing series. */
export interface RecurrenceView {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday: number[];
  until: string | null;
  count: number | null;
  /** True when the stored rule has parts the editor cannot represent and must keep. */
  custom: boolean;
  raw: string;
}

const RENDERED_PARTS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT']);

/**
 * Read a stored RRULE back into the editor shape. Known parts round-trip; any
 * other part (BYSETPOS, BYMONTHDAY, WKST, …) marks the rule `custom` so the
 * series editor keeps it untouched unless the user replaces the recurrence.
 */
export function recurrenceViewFromRRule(rrule: string | null | undefined): RecurrenceView | null {
  if (typeof rrule !== 'string' || !rrule.trim()) return null;
  const raw = rrule.trim();
  const fields = new Map<string, string>();
  let custom = false;
  for (const part of raw.split(';')) {
    const [key, partValue] = part.split('=');
    const name = (key || '').trim().toUpperCase();
    const value = (partValue || '').trim();
    if (!name || !value) { custom = true; continue; }
    if (!RENDERED_PARTS.has(name)) custom = true;
    fields.set(name, value);
  }
  const frequency = (fields.get('FREQ') || '').toLowerCase();
  if (!isRecurrenceFrequency(frequency)) return { frequency: 'daily', interval: 1, byWeekday: [], until: null, count: null, custom: true, raw };
  const interval = Number(fields.get('INTERVAL') || 1);
  const byWeekday = (fields.get('BYDAY') || '').split(',').map(code => WEEKDAY_CODES.indexOf(code.trim().toUpperCase() as typeof WEEKDAY_CODES[number])).filter(day => day >= 0);
  const until = fields.get('UNTIL') || null;
  const countValue = fields.get('COUNT');
  const count = countValue ? Number(countValue) : null;
  return {
    frequency,
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
    byWeekday: [...new Set(byWeekday)].sort((left, right) => left - right),
    until,
    count: count !== null && Number.isInteger(count) && count > 0 ? count : null,
    custom,
    raw,
  };
}
