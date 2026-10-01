export interface SearchFilter { key: string; value: string; negate: boolean }
export interface SearchTerm { value: string; negate: boolean }

/** Tokenize once: quotes delimit phrases, never become literal search characters. */
export function parseSearchQuery(raw: string): { filters: SearchFilter[]; terms: SearchTerm[] } {
  const tokens: string[] = [];
  let token = ''; let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\')) { token += raw[++i]; }
    else if (char === '"') quoted = !quoted;
    else if (/\s/.test(char) && !quoted) { if (token) tokens.push(token); token = ''; }
    else token += char;
  }
  if (token) tokens.push(token);
  const filters: SearchFilter[] = []; const terms: SearchTerm[] = [];
  for (let value of tokens) {
    if (!value || value === '-') continue;
    const negate = value.startsWith('-');
    if (negate) value = value.slice(1);
    const operator = /^(from|to|subject|has|is|after|before|in):(.*)$/i.exec(value);
    if (operator) {
      if (operator[2].trim()) filters.push({ key: operator[1].toLowerCase(), value: operator[2].trim().toLowerCase(), negate });
    } else if (value) terms.push({ value, negate });
  }
  return { filters, terms };
}

/** User text is literal, not a SQL LIKE pattern. */
export function escapeSearchLike(value: string): string { return value.replace(/[\\%_]/g, '\\$&'); }
