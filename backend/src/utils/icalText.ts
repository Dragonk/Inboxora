/**
 * iCalendar text helpers shared by the provider adapters (P09).
 *
 * RFC 5545 §3.3.11 escapes text values and §3.1 folds physical lines at 75
 * octets. Both are easy to get subtly wrong (a comma inside a SUMMARY, a
 * multi-byte character at the fold boundary), so the adapters share one tested
 * implementation instead of each carrying its own.
 */

/** Escape an iCalendar TEXT value (backslash, semicolon, comma, newline). */
export function escapeICalendarText(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Escape a parameter value, quoting it when it contains a delimiter. */
export function escapeICalendarParameter(value: unknown): string {
  const text = String(value ?? '').replace(/[\r\n]/g, ' ');
  return /[;:,]/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

/** Fold one logical line into physical lines of at most 75 octets. */
export function foldICalendarLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const chunks: string[] = [];
  let chunk = '';
  for (const character of line) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 74) {
      chunks.push(chunk);
      chunk = character;
    } else chunk += character;
  }
  chunks.push(chunk);
  return chunks.join('\r\n ');
}

/** A `Date` as an iCalendar UTC date-time (`YYYYMMDDTHHMMSSZ`). */
export function formatICalendarUtc(value: Date): string {
  const pad = (part: number, size = 2) => String(part).padStart(size, '0');
  return `${pad(value.getUTCFullYear(), 4)}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}`
    + `T${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

/** A `Date` as an iCalendar date-only value (`YYYYMMDD`). */
export function formatICalendarDate(value: Date): string {
  const pad = (part: number, size = 2) => String(part).padStart(size, '0');
  return `${pad(value.getUTCFullYear(), 4)}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}`;
}
