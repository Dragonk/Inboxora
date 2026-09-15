import { intlLocale } from './intlLocale.ts';
// Reuse Intl formatters across large mail lists; labels follow the selected UI locale.
const formatters = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat>();
type DateKind = 'time' | 'date' | 'date-year';
function dateFormatter(locale: string | null | undefined, kind: DateKind): Intl.DateTimeFormat {
  const resolved = intlLocale(locale);
  const key = `${resolved || ''}:${kind}`;
  const cached = formatters.get(key);
  if (cached instanceof Intl.DateTimeFormat) return cached;
  const options: Intl.DateTimeFormatOptions = kind === 'time' ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', ...(kind === 'date-year' ? { year: 'numeric' } : {}) };
  const created = new Intl.DateTimeFormat(resolved, options);
  formatters.set(key, created);
  return created;
}
function relativeFormatter(locale: string | null | undefined): Intl.RelativeTimeFormat {
  const resolved = intlLocale(locale);
  const key = `${resolved || ''}:relative`;
  const cached = formatters.get(key);
  if (cached instanceof Intl.RelativeTimeFormat) return cached;
  const created = new Intl.RelativeTimeFormat(resolved, { numeric: 'auto' });
  formatters.set(key, created);
  return created;
}
export function formatDate(dateStr: string | number | Date | null | undefined, locale: string | null | undefined, now: Date = new Date()) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return dateFormatter(locale, 'time').format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return relativeFormatter(locale).format(-1, 'day');
  return dateFormatter(locale, date.getFullYear() === now.getFullYear() ? 'date' : 'date-year').format(date);
}
