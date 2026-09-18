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
