/** Search external values, never JSON property names or serialization punctuation. */
function containsText(value: unknown, term: string, depth = 0): boolean {
  if (typeof value === 'string') return value.toLocaleLowerCase().includes(term);
  if (depth >= 16 || value === null || typeof value !== 'object') return false;
  const values: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return values.some(item => containsText(item, term, depth + 1));
}
export function eventMatchesSearch(event: Record<string, unknown>, term: string): boolean {
  const normalized = term.trim().toLocaleLowerCase();
  return normalized.length > 0 && ['summary','description','location','organizer','attendees']
    .some(key => containsText(event[key], normalized));
}
