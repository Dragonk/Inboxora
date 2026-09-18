// Authentication-Results header parser for the antispam classifier.
//
// Parses `Authentication-Results:` per RFC 7601 (updated by RFC 8601).
// Defensive: accepts an array of raw header lines or a lowercase-name header
// map (the shape produced by the message parser), multi-header and
// folded-header safe.
//
// Trust gate: a header is only meaningful when written by a mail system the
// account owner trusts (`email_accounts.trusted_authserv_id`). With no
// trusted id configured, every header is ignored and the auth signal stays
// neutral — a forged header can neither add pass weights nor silence
// AUTH_*_FAIL rules.

const KNOWN_METHODS: ReadonlySet<string> = new Set(['dkim', 'spf', 'dmarc']);

const PASS_VALUES: ReadonlySet<string> = new Set(['pass', 'best_guess_pass']);

export type AuthResults = { dkim: string | null; spf: string | null; dmarc: string | null };

export type HeaderInput = ReadonlyArray<string> | Record<string, string | ReadonlyArray<string> | undefined> | null | undefined;

function unfoldHeaderLines(lines: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const text = String(line);
    if (/^[\t ]/.test(text) && result.length > 0) {
      result[result.length - 1] += ' ' + text.trim();
    } else {
      result.push(text.trim());
    }
  }
  return result;
}

export function extractAuthResultHeaders(headers: HeaderInput): string[] {
  if (Array.isArray(headers)) {
    return unfoldHeaderLines(headers)
      .filter(line => /^authentication-results\s*:/i.test(line))
      .map(line => line.replace(/^authentication-results\s*:\s*/i, ''));
  }
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
    const record = headers as Record<string, string | ReadonlyArray<string> | undefined>;
    const value = record['authentication-results'] ?? record['Authentication-Results'];
    if (value === undefined) return [];
    const raw: string[] = Array.isArray(value) ? [...value] : [String(value)];
    const lines: string[] = [];
    for (const v of raw) {
      for (const line of String(v).replace(/\r\n/g, '\n').split('\n')) lines.push(line);
    }
    return unfoldHeaderLines(lines)
      .map(line => line.replace(/^authentication-results\s*:\s*/i, '').trim())
      .filter(v => v.length > 0);
  }
  return [];
}

export function extractAuthservId(payload: string | null | undefined): string | null {
  const first = String(payload ?? '').split(';')[0] ?? '';
  const stripped = first.replace(/\([^)]*\)/g, ' ').trim();
  const token = stripped.split(/\s+/)[0] ?? '';
  const id = token.split('/')[0]?.trim().toLowerCase() ?? '';
  return id || null;
}

export function normalizeAuthservId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase().split('/')[0]?.trim() ?? '';
  return id || null;
}

export function extractAuthservIds(headers: HeaderInput): string[] {
  const seen: string[] = [];
  for (const payload of extractAuthResultHeaders(headers)) {
    const id = extractAuthservId(payload);
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

function trustedSet(trustedAuthservIds: unknown): Set<string> {
  const list = Array.isArray(trustedAuthservIds)
    ? trustedAuthservIds
    : trustedAuthservIds === null || trustedAuthservIds === undefined ? [] : [trustedAuthservIds];
  const out = new Set<string>();
  for (const entry of list) {
    const id = normalizeAuthservId(entry);
    if (id) out.add(id);
  }
  return out;
}

export function hasTrustedAuthResults(headers: HeaderInput, trustedAuthservIds: unknown): boolean {
  const trusted = trustedSet(trustedAuthservIds);
  if (trusted.size === 0) return false;
  return extractAuthResultHeaders(headers).some(payload => {
    const id = extractAuthservId(payload);
    return id !== null && trusted.has(id);
  });
}

export function parseAuthResults(headers: HeaderInput, opts: { trustedAuthservIds?: unknown } = {}): AuthResults {
  const trusted = trustedSet(opts.trustedAuthservIds);
  const result: AuthResults = { dkim: null, spf: null, dmarc: null };
  if (trusted.size === 0) return result;

  const payloads = extractAuthResultHeaders(headers).filter(payload => {
    const id = extractAuthservId(payload);
    return id !== null && trusted.has(id);
  });
  if (payloads.length === 0) return result;

  const byMethod = new Map<string, string>();
  const passed = new Set<string>();

  for (const payload of payloads) {
    for (const segment of splitResultSegments(payload)) {
      const match = /^([a-z0-9_.-]+)\s*=\s*([a-z0-9_]+)/i.exec(segment);
      if (!match) continue;
      const method = (match[1] ?? '').toLowerCase();
      const value = (match[2] ?? '').toLowerCase();
      if (!KNOWN_METHODS.has(method)) continue;
      if (PASS_VALUES.has(value)) {
        passed.add(method);
      } else if (!byMethod.has(method)) {
        byMethod.set(method, value);
      }
    }
  }

  for (const method of KNOWN_METHODS) {
    if (passed.has(method)) {
      result[method as keyof AuthResults] = 'pass';
    } else if (byMethod.has(method)) {
      result[method as keyof AuthResults] = byMethod.get(method) ?? null;
    }
  }
  return result;
}

function splitResultSegments(payload: string): string[] {
  const segments: string[] = [];
  for (const part of payload.split(';')) {
    const stripped = part.replace(/\([^)]*\)/g, '').trim();
    if (!stripped) continue;
    if (!stripped.includes('=')) continue;
    segments.push(stripped);
  }
  return segments;
}
