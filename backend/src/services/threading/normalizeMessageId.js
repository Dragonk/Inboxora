// Normalize RFC 5322 Message-ID values for stable identity comparisons.
// Message-IDs are opaque tokens: preserve case and remove only transport noise.
const MAX_MESSAGE_ID_LENGTH = 998;

export function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return null;

  const angleWrapped = text.match(/^<([^<>]*)>$/);
  const candidate = (angleWrapped ? angleWrapped[1] : text).trim();
  if (!candidate || candidate.length > MAX_MESSAGE_ID_LENGTH) return null;
  if (/\s/.test(candidate) || /[^\x21-\x7e]/.test(candidate) || /[<>]/.test(candidate)) return null;
  return `<${candidate}>`;
}

export function normalizeMessageIdList(value) {
  if (value === null || value === undefined) return [];
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  const ids = [];
  const seen = new Set();
  for (const match of text.matchAll(/<[^<>\r\n]+>/g)) {
    const normalized = normalizeMessageId(match[0]);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return ids;
}

export function messageIdLookupVariants(value) {
  const normalized = normalizeMessageId(value);
  if (!normalized) return [];
  const bare = normalized.slice(1, -1);
  return [normalized, bare];
}
