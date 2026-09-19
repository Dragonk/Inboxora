/**
 * WebDAV conditional-request helpers.
 *
 * RFC 9110 §13.1.1 requires `If-Match` to use *strong* comparison: a weak
 * validator (`W/"…"`) can never satisfy it. The previous CalDAV and CardDAV
 * checks stripped the `W/` prefix (or compared the raw string), so a weak
 * validator could be treated as a strong one. Failing the condition is the safe
 * direction for a write, so anything that is not a strong, exact match is
 * rejected.
 */

/** Strip a single pair of surrounding double quotes from an entity-tag. */
function unquote(value: string): string {
  return /^".*"$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Whether an `If-Match` header permits an operation.
 * - absent header: no condition, allowed;
 * - `*`: allowed only when the resource exists;
 * - otherwise: a comma-separated list of entity-tags, any strong one of which
 *   must equal the current strong ETag.
 */
export function ifMatchSatisfied(header: string | undefined | null, currentEtag: string | null | undefined): boolean {
  if (header === undefined || header === null || header.trim() === '') return true;
  const value = header.trim();
  if (value === '*') return Boolean(currentEtag);
  if (!currentEtag) return false;
  return value.split(',').some(candidate => {
    const trimmed = candidate.trim();
    // A weak validator never satisfies If-Match (strong comparison).
    if (!trimmed || trimmed.startsWith('W/')) return false;
    return unquote(trimmed) === currentEtag;
  });
}

/**
 * Whether an `If-None-Match` header permits an operation. Only `*` is handled
 * here because that is the create-only form the DAV routes support; other forms
 * fall back to "no condition".
 */
export function ifNoneMatchAllowsCreate(header: string | undefined | null, exists: boolean): boolean {
  if (header === undefined || header === null) return true;
  if (header.trim() !== '*') return true;
  return !exists;
}

/**
 * The WebDAV `If` header (RFC 4918 §10.4).
 *
 * This is a precondition, not a hint: a syntactically valid condition the server
 * cannot evaluate must **fail**, never be treated as absent, or a client's
 * optimistic-concurrency guard silently stops protecting it. Only the untagged
 * form is evaluated, because that is what a single-resource PUT/DELETE uses; a
 * tagged list is a valid header we cannot honour here, so it fails closed.
 *
 * - `(["etag"])` — an entity-tag condition, strong comparison (a weak validator
 *   never matches), like `If-Match`;
 * - `(<state-token>)` — a state-token condition, compared against the collection's
 *   sync token;
 * - `Not` negates a condition, and parentheses are OR-ed while the conditions
 *   inside one pair are AND-ed.
 *
 * A malformed header is a client error (400); a well-formed header whose condition
 * is not met — or that uses a form we do not evaluate — is a failed precondition
 * (412).
 */
export type DavIfDecision =
  | { status: 'proceed' }
  | { status: 'precondition-failed' }
  | { status: 'bad-request' };

interface DavIfCondition {
  negated: boolean;
  kind: 'etag' | 'sync-token';
  value: string;
}

interface ParsedDavIfHeader {
  lists: DavIfCondition[][];
  /** A resource tag was present: valid RFC 4918, but not evaluated here. */
  tagged: boolean;
}

function isWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

/** `null` means malformed; a parsed header always has at least one condition. */
function parseDavIfHeader(raw: string): ParsedDavIfHeader | null {
  const text = raw.trim();
  if (!text) return null;
  const lists: DavIfCondition[][] = [];
  let current: DavIfCondition[] | null = null;
  let tagged = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (isWhitespace(character)) { index += 1; continue; }
    if (character === '(') {
      if (current) return null; // a list cannot contain another list
      current = [];
      index += 1;
      continue;
    }
    if (character === ')') {
      if (!current || current.length === 0) return null; // `()` is not a condition
      lists.push(current);
      current = null;
      index += 1;
      continue;
    }
    if (current === null) {
      // Anything outside a list must be a resource tag, i.e. a tagged list.
      if (character !== '<') return null;
      const end = text.indexOf('>', index + 1);
      if (end < 0) return null;
      tagged = true;
      index = end + 1;
      continue;
    }

    let negated = false;
    if (text.startsWith('Not', index) && (isWhitespace(text[index + 3]) || text[index + 3] === '[' || text[index + 3] === '<')) {
      negated = true;
      index += 3;
      while (isWhitespace(text[index])) index += 1;
    }
    const opener = text[index];
    const closer = opener === '[' ? ']' : opener === '<' ? '>' : null;
    if (!closer) return null;
    const end = text.indexOf(closer, index + 1);
    if (end < 0) return null;
    const value = text.slice(index + 1, end).trim();
    if (!value) return null;
    current.push({ negated, kind: opener === '[' ? 'etag' : 'sync-token', value });
    index = end + 1;
  }

  if (current) return null; // unbalanced parenthesis
  if (lists.length === 0) return null;
  return { lists, tagged };
}

function etagConditionHolds(condition: DavIfCondition, currentEtag: string | null | undefined): boolean {
  // Strong comparison: a weak validator never matches, exactly as for If-Match.
  const matches = Boolean(currentEtag)
    && !condition.value.startsWith('W/')
    && unquote(condition.value) === currentEtag;
  return condition.negated ? !matches : matches;
}

function syncTokenConditionHolds(condition: DavIfCondition, currentToken: string | null | undefined): boolean {
  const matches = Boolean(currentToken) && condition.value === currentToken;
  return condition.negated ? !matches : matches;
}

/** Evaluate an `If` header against the resource's ETag and its collection token. */
export function evaluateDavIf(
  header: string | string[] | undefined | null,
  context: { etag?: string | null; syncToken?: string | null },
): DavIfDecision {
  // A repeated header is equivalent to one header holding both values.
  const raw = Array.isArray(header) ? header.join(' ') : header;
  if (raw === undefined || raw === null || raw.trim() === '') return { status: 'proceed' };
  const parsed = parseDavIfHeader(raw);
  if (!parsed) return { status: 'bad-request' };
  if (parsed.tagged) return { status: 'precondition-failed' };
  const satisfied = parsed.lists.some(list => list.every(condition => (
    condition.kind === 'etag'
      ? etagConditionHolds(condition, context.etag)
      : syncTokenConditionHolds(condition, context.syncToken)
  )));
  return satisfied ? { status: 'proceed' } : { status: 'precondition-failed' };
}
