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

// Express types a route parameter as string | string[]; this application only ever
// registers scalar parameters, so this narrows the union explicitly.
export function routeParam(value: unknown): string {
  return queryString(value) ?? '';
}

// The authenticated user id. The auth middleware guarantees a session user; a missing one is a
// programming error, so this narrows once instead of every route asserting it.
export function sessionUserId(req: { session?: { userId?: string } }): string {
  const id = req.session?.userId;
  if (!id) throw Object.assign(new Error('Not authenticated'), { statusCode: 401 });
  return id;
}

