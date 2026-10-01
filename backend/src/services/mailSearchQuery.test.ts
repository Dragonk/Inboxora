import { describe, expect, it } from 'vitest';
import { escapeSearchLike, parseSearchQuery } from './mailSearchQuery.js';

describe('mail search tokenization', () => {
  it('keeps quoted free-text phrases intact and strips their delimiters', () => {
    expect(parseSearchQuery('"invoice number" -"wrong order"')).toEqual({ filters: [], terms: [
      { value: 'invoice number', negate: false }, { value: 'wrong order', negate: true },
    ] });
  });
  it('does not interpret an operator embedded inside a phrase', () => {
    expect(parseSearchQuery('subject:"from:alice newsletter" from:"Jan Kowalski"')).toEqual({
      filters: [{ key: 'subject', value: 'from:alice newsletter', negate: false }, { key: 'from', value: 'jan kowalski', negate: false }], terms: [],
    });
  });
  it('accepts Polish, one-character terms and unclosed quotes while typing', () => {
    expect(parseSearchQuery('żółw x "numer faktury').terms.map(term => term.value)).toEqual(['żółw', 'x', 'numer faktury']);
  });
  it('escapes wildcard characters instead of widening the search', () => {
    expect(escapeSearchLike('100%_C:\\mail')).toBe('100\\%\\_C:\\\\mail');
  });
});
