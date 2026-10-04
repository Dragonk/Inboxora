import { describe, it, expect } from 'vitest';

import { parseSearchQueryLocal } from './search.js';

describe('parseSearchQueryLocal tests (testing improvement task)', () => {
  it('correctly parses unquoted tokens as individual freetext terms', () => {
    const query = parseSearchQueryLocal('hello world');
    expect(query).toEqual({
      type: 'all',
      clauses: [
        { type: 'freetext', term: 'hello' },
        { type: 'freetext', term: 'world' }
      ]
    });
  });

  it('correctly strips double-quotes to parse exact phrases as freetext terms', () => {
    const query = parseSearchQueryLocal('"hello world"');
    expect(query).toEqual({
      type: 'all',
      clauses: [
        { type: 'freetext', term: 'hello world' }
      ]
    });
  });

  it('handles mixed tokens and quoted phrases correctly', () => {
    const query = parseSearchQueryLocal('foo "bar baz" qux');
    expect(query).toEqual({
      type: 'all',
      clauses: [
        { type: 'freetext', term: 'foo' },
        { type: 'freetext', term: 'bar baz' },
        { type: 'freetext', term: 'qux' }
      ]
    });
  });

  it('handles an empty string', () => {
    const query = parseSearchQueryLocal('');
    expect(query).toEqual({
      type: 'all',
      clauses: []
    });
  });

  it('handles strings with only whitespace', () => {
    const query = parseSearchQueryLocal('   ');
    expect(query).toEqual({
      type: 'all',
      clauses: []
    });
  });

  it('handles empty quotes', () => {
    const query = parseSearchQueryLocal('""');
    expect(query).toEqual({
      type: 'all',
      clauses: [
        { type: 'freetext', term: '' }
      ]
    });
  });

  it('handles multiple consecutive quotes correctly', () => {
    const query = parseSearchQueryLocal('"foo" "bar"');
    expect(query).toEqual({
      type: 'all',
      clauses: [
        { type: 'freetext', term: 'foo' },
        { type: 'freetext', term: 'bar' }
      ]
    });
  });
});
