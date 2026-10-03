// Compose preferences accept bare dot-atom mailboxes only. The transport parser
// also accepts display names and is intentionally not used for this settings API.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

type Defaults = { default_cc?: string[]; default_bcc?: string[] };
type AliasDefaults = { default_cc?: string[] | null; default_bcc?: string[] | null };
const fields = ['default_cc', 'default_bcc'] as const;

function normalizeRecipientArray(field: typeof fields[number], values: unknown): string[] | { error: string } {
  if (!Array.isArray(values) || values.length > 50) {
    return { error: `${field} must be an array of at most 50 email addresses` };
  }
  const normalized: string[] = [];
  for (const value of values) {
    // Check before trimming so leading/trailing header controls cannot disappear.
    if (typeof value !== 'string' || CONTROL.test(value) || value.length > 254) {
      return { error: `${field} contains an invalid email address` };
    }
    const address = value.trim().toLowerCase();
    const parts = address.split('@');
    const [local, domain] = parts;
    if (parts.length !== 2 || !local || local.length > 64 || !LOCAL_PART.test(local)
      || !domain || !domain.includes('.') || !domain.split('.').every(label => DOMAIN_LABEL.test(label))) {
      return { error: `${field} contains an invalid bare email address` };
    }
    normalized.push(address);
  }
  return [...new Set(normalized)];
}

/** Validate both optional account lists before any write; normalize only safe bare mailboxes. */
export function normalizeDefaultRecipients(input: Record<string, unknown>): Defaults | { error: string } {
  const result: Defaults = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const normalized = normalizeRecipientArray(field, input[field]);
    if ('error' in normalized) return normalized;
    result[field] = normalized;
  }
  return result;
}

/** Alias NULL means inherit that account field; an array, including [], is an explicit override. */
export function normalizeAliasDefaultRecipients(input: Record<string, unknown>): AliasDefaults | { error: string } {
  const result: AliasDefaults = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    if (input[field] === null) {
      result[field] = null;
      continue;
    }
    const normalized = normalizeRecipientArray(field, input[field]);
    if ('error' in normalized) return normalized;
    result[field] = normalized;
  }
  return result;
}
