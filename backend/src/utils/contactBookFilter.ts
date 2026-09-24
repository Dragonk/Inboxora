/** Missing filter = legacy default. Present empty filter = no books. */
export const BOOK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type BookFilter = { ok: true; ids: string[] | null } | { ok: false; code: 'INVALID_BOOK_FILTER' };
export function parseBookFilter(value: unknown, present: boolean): BookFilter {
  if (!present) return { ok: true, ids: null };
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => typeof item !== 'string')) return { ok: false, code: 'INVALID_BOOK_FILTER' };
  const ids = [...new Set((values as string[]).flatMap(item => item.split(',')).map(id => id.trim().toLowerCase()).filter(Boolean))];
  if (ids.length > 500 || ids.some(id => !BOOK_ID_PATTERN.test(id))) return { ok: false, code: 'INVALID_BOOK_FILTER' };
  return { ok: true, ids };
}
