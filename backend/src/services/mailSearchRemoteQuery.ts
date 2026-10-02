import type { SearchObject } from 'imapflow';
import { parseSearchQuery } from './mailSearchQuery.js';

/** Provider syntax is generated from the closed local grammar, not concatenated raw. */
export function searchDate(value: string): Date {
  value = value.toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw Object.assign(new Error('Search dates must use YYYY-MM-DD or ISO 8601 with a timezone.'), { statusCode: 400 });
  const date = new Date(value);
  const calendarDate = new Date(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0,10) !== value.slice(0,10)) throw Object.assign(new Error('Invalid search date.'), { statusCode: 400 });
  if (!Number.isFinite(date.getTime()) || (value.length === 10 && date.toISOString().slice(0,10) !== value)) throw Object.assign(new Error('Invalid search date.'), { statusCode: 400 });
  return date;
}
function quoted(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
export function gmailSearchQuery(raw: string): string {
  const { filters, terms } = parseSearchQuery(raw);
  const pieces = terms.map(term => `${term.negate ? '-' : ''}${quoted(term.value)}`);
  for (const filter of filters) {
    const prefix = filter.negate ? '-' : '';
    if (filter.key === 'from' || filter.key === 'subject') pieces.push(`${prefix}${filter.key}:${quoted(filter.value)}`);
    else if (filter.key === 'to') pieces.push(`${prefix}{to:${quoted(filter.value)} cc:${quoted(filter.value)}}`);
    else if (filter.key === 'after' || filter.key === 'before') pieces.push(`${prefix}${filter.key}:${(filter.key === 'after' ? Math.floor(searchDate(filter.value).getTime() / 1000) - 1 : Math.ceil(searchDate(filter.value).getTime() / 1000) + 1)}`);
    else if (filter.key === 'has' && filter.value === 'attachment') pieces.push(`${prefix}has:attachment`);
    else if (filter.key === 'is' && ['read','unread','starred'].includes(filter.value)) pieces.push(`${prefix}is:${filter.value}`);
    // Local metadata also enforces flags/attachments. Ignoring these here creates a
    // superset and avoids false negatives from pending provider flag changes.
  }
  return pieces.join(' ') || 'in:anywhere';
}
export function graphSearchQuery(raw: string): string {
  const { filters, terms } = parseSearchQuery(raw);
  const pieces = terms.map(term => `${term.negate ? 'NOT ' : ''}(${['from','subject','body','to','cc'].map(field => `${field}:${quoted(term.value)}`).join(' OR ')})`);
  for (const filter of filters) {
    let value: string | undefined;
    if (filter.key === 'from' || filter.key === 'subject') value = `${filter.key}:${quoted(filter.value)}`;
    if (filter.key === 'to') value = `(to:${quoted(filter.value)} OR cc:${quoted(filter.value)})`;
    // Date and flag filters are applied to the local projection. KQL calendar-day
    // comparisons would lose valid messages at timezone boundaries.
    if (value) pieces.push(`${filter.negate ? 'NOT ' : ''}${value}`);
  }
  // Search-only metadata operators have no text. '*' requests a bounded superset.
  return pieces.join(' AND ') || '*';
}
export function imapSearchQuery(raw: string): SearchObject {
  const { filters, terms } = parseSearchQuery(raw);
  const conditions: SearchObject[] = terms.map(term => term.negate ? { not: { text: term.value } } : { text: term.value });
  for (const filter of filters) {
    let condition: SearchObject | undefined;
    if (filter.key === 'from') condition = { from: filter.value };
    if (filter.key === 'subject') condition = { subject: filter.value };
    if (filter.key === 'to') condition = { or: [{ to: filter.value }, { cc: filter.value }] };
    // IMAP SEARCH dates are day-granular INTERNALDATE, whereas Inboxora searches
    // the message's Date header. Leave date/flags/attachments to the local filter.
    if (condition) conditions.push(filter.negate ? { not: condition } : condition);
  }
  if (!conditions.length) return { all: true };
  if (conditions.length === 1) return conditions[0];
  // IMAP has no named AND property. NOT (NOT a OR NOT b) represents exact AND,
  // including repeated from:/subject: operators that object assignment would lose.
  return { not: { or: conditions.map(condition => ({ not: condition })) } };
}
