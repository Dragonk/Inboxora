// Express parses query strings into `string | string[] | ParsedQs`. Routes almost
// always want a single string or integer; these accessors narrow the union
// explicitly instead of asserting, so a malformed `?a[]=x` can never silently
// reach a string-only helper.

export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
    }
  }
  return undefined;
}

export function queryStringOr(value: unknown, fallback: string): string {
  return queryString(value) ?? fallback;
}

export function queryInt(value: unknown, fallback: number): number {
  const raw = queryString(value);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
