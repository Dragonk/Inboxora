import { describe, expect, it } from 'vitest';
import { parseBookFilter } from './contactBookFilter.js';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
describe('multi-book filter contract', () => {
  it('distinguishes absence from a deliberate empty filter', () => {
    expect(parseBookFilter(undefined, false)).toEqual({ ok: true, ids: null });
    expect(parseBookFilter('', true)).toEqual({ ok: true, ids: [] });
    expect(parseBookFilter([], true)).toEqual({ ok: true, ids: [] });
  });
  it('normalizes and deduplicates comma/repeated parameters', () => {
    expect(parseBookFilter([a, `${b},${a}`], true)).toEqual({ ok: true, ids: [a,b] });
  });
  it('refuses malformed query types rather than silently ignoring them', () => {
    expect(parseBookFilter({ id: a }, true).ok).toBe(false);
    expect(parseBookFilter([a, 7], true).ok).toBe(false);
    expect(parseBookFilter('not-a-uuid', true).ok).toBe(false);
  });
  it('bounds the unique set', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `${i.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`);
    expect(parseBookFilter(ids, true).ok).toBe(false);
  });
});
