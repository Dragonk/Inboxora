import { describe, expect, it } from 'vitest';
import { escapeSearchLike, parseSearchQuery } from './mailSearchQuery.js';

describe('mail search tokenization', () => {
  it('keeps quoted free-text phrases intact and strips their delimiters', () => {
    expect(parseSearchQuery('"invoice number" -"wrong order"')).toEqual({ filters: [], terms: [
      { value: 'invoice number', negate: false }, { value: 'wrong order', negate: true },
    ] });
  });
  it('treats a token that starts quoted as literal text, not an operator or exclusion', () => {
    expect(parseSearchQuery('"from:alice newsletter" "-5%"')).toEqual({
      filters: [], terms: [
        { value: 'from:alice newsletter', negate: false },
        { value: '-5%', negate: false },
      ],
    });
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
  it('splits unquoted free text into independent terms', () => {
    expect(parseSearchQuery('hello world')).toEqual({ filters: [], terms: [
      { value: 'hello', negate: false },
      { value: 'world', negate: false },
    ] });
  });
  it('keeps mixed quoted phrases and unquoted tokens in order', () => {
    expect(parseSearchQuery('foo "bar baz" qux')).toEqual({ filters: [], terms: [
      { value: 'foo', negate: false },
      { value: 'bar baz', negate: false },
      { value: 'qux', negate: false },
    ] });
  });
  it('ignores whitespace and empty quoted phrases instead of creating empty search terms', () => {
    expect(parseSearchQuery('')).toEqual({ filters: [], terms: [] });
    expect(parseSearchQuery('   ')).toEqual({ filters: [], terms: [] });
    expect(parseSearchQuery('""   ""')).toEqual({ filters: [], terms: [] });
  });
  it('parses consecutive quoted phrases independently', () => {
    expect(parseSearchQuery('"foo" "bar"')).toEqual({ filters: [], terms: [
      { value: 'foo', negate: false },
      { value: 'bar', negate: false },
    ] });
  });
});
