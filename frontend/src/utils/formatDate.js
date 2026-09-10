import { intlLocale } from './intlLocale.js';
// Reuse Intl formatters across large mail lists; labels follow the selected UI locale.
const formatters = new Map();
function formatter(locale, kind) {
  locale = intlLocale(locale);
  const key = `${locale || ''}:${kind}`;
  if (!formatters.has(key)) {
    const options = kind === 'time' ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', ...(kind === 'date-year' ? { year: 'numeric' } : {}) };
    formatters.set(key, kind === 'relative'
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
      : new Intl.DateTimeFormat(locale, options));
  }
  return formatters.get(key);
}
export function formatDate(dateStr, locale, now = new Date()) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return formatter(locale, 'time').format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return formatter(locale, 'relative').format(-1, 'day');
  return formatter(locale, date.getFullYear() === now.getFullYear() ? 'date' : 'date-year').format(date);
}
