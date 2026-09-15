import { intlLocale } from './intlLocale.ts';

// The compact time line for a mail invitation. Only what is needed to recognise the
// event: when it starts, and when it ends when that carries information. The title and
// body already appear around the panel, so repeating them there is noise.
//
// All-day invitations are date-only — an all-day event runs to the *start* of its last
// day, so the stored end is exclusive and must not be shown as a second date.
type RangeKind = 'date' | 'dateTime' | 'time';

const RANGE_FORMAT: Record<RangeKind, Intl.DateTimeFormatOptions> = {
  date: { month: 'short', day: 'numeric', year: 'numeric' },
  dateTime: { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
  time: { hour: 'numeric', minute: '2-digit' },
};

const _formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, kind: RangeKind): Intl.DateTimeFormat {
  const key = `${locale}:${kind}`;
  let cached = _formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, RANGE_FORMAT[kind]);
    _formatters.set(key, cached);
  }
  return cached;
}

function valid(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Day difference in whole days, so "same day" is judged on the calendar day rather
// than on a 24-hour span that a late-evening event would straddle.
function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * Formats an invitation's date range for display, e.g.
 *   "10 wrz 2026, 09:00–10:00"   — timed, same day
 *   "10 wrz 2026, 23:00 – 11 wrz 2026, 01:00" — timed, across days
 *   "10 wrz 2026"                 — all-day
 * Returns '' when the invitation carries no usable start, so the caller can omit the line.
 */
export function formatInvitationRange(invitation: Record<string, unknown>, language: string): string {
  const start = valid(invitation?.startsAt);
  if (!start) return '';
  const locale = intlLocale(language);
  // All-day: the end is exclusive (the following midnight), so it is never shown.
  if (invitation.allDay) return formatter(locale, 'date').format(start);
  const end = valid(invitation?.endsAt);
  if (!end || end <= start) return formatter(locale, 'dateTime').format(start);
  if (sameDay(start, end)) {
    return `${formatter(locale, 'dateTime').format(start)}–${formatter(locale, 'time').format(end)}`;
  }
  return `${formatter(locale, 'dateTime').format(start)} – ${formatter(locale, 'dateTime').format(end)}`;
}
