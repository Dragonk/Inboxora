import { describe, expect, it } from 'vitest';
import { GRAPH_SEARCH_MAX_QUERY_LENGTH, boundGraphSearchQuery, graphMailSearchUrl } from './graphMailSearch.js';

describe('Graph search Unicode and URL safety', () => {
  it.each(['Zażółć gęślą jaźń','invoice 😀 100%','a & b # value + plus','日本語の件名'])('preserves a bounded literal without URL parameter injection: %s', value => {
    expect(boundGraphSearchQuery(value)).toBe(value);
    const url = new URL(graphMailSearchUrl(value));
    expect(url.searchParams.get('$search')).toBe(`"${value}"`);
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()].filter(key => !['$search','$select','$top'].includes(key))).toEqual([]);
  });
  it('rejects oversized compiled Unicode instead of silently changing its meaning', () => {
    const query = 'ż'.repeat(GRAPH_SEARCH_MAX_QUERY_LENGTH + 1);
    expect(() => boundGraphSearchQuery(query)).toThrow('too long');
    expect(() => graphMailSearchUrl(query)).toThrow('too long');
  });
  it('escapes quotes and backslashes inside the KQL search literal', () => {
    const url = new URL(graphMailSearchUrl('quote " and \\ path'));
    expect(url.searchParams.get('$search')).toBe('"quote \\" and \\\\ path"');
  });
});
