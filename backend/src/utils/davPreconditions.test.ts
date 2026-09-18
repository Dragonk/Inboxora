import { describe, expect, it } from 'vitest';
import { ifMatchSatisfied, ifNoneMatchAllowsCreate } from './davPreconditions.js';

describe('ifMatchSatisfied (strong comparison)', () => {
  it('allows the request when there is no condition', () => {
    expect(ifMatchSatisfied(undefined, 'abc')).toBe(true);
    expect(ifMatchSatisfied('', 'abc')).toBe(true);
  });

  it('matches an exact strong entity-tag with or without quotes', () => {
    expect(ifMatchSatisfied('"abc"', 'abc')).toBe(true);
    expect(ifMatchSatisfied('abc', 'abc')).toBe(true);
  });

  it('never lets a weak validator satisfy If-Match', () => {
    expect(ifMatchSatisfied('W/"abc"', 'abc')).toBe(false);
    expect(ifMatchSatisfied('W/abc', 'abc')).toBe(false);
  });

  it('rejects a differing tag and a missing current tag', () => {
    expect(ifMatchSatisfied('"abc"', 'def')).toBe(false);
    expect(ifMatchSatisfied('"abc"', null)).toBe(false);
    expect(ifMatchSatisfied('"abc"', undefined)).toBe(false);
  });

  it('accepts any strong tag in a comma-separated list', () => {
    expect(ifMatchSatisfied('"one", "two", "abc"', 'abc')).toBe(true);
    expect(ifMatchSatisfied('"one", W/"abc"', 'abc')).toBe(false);
  });

  it('treats * as "the resource must exist"', () => {
    expect(ifMatchSatisfied('*', 'abc')).toBe(true);
    expect(ifMatchSatisfied('*', null)).toBe(false);
  });
});

describe('ifNoneMatchAllowsCreate', () => {
  it('only enforces the * form', () => {
    expect(ifNoneMatchAllowsCreate(undefined, true)).toBe(true);
    expect(ifNoneMatchAllowsCreate('"abc"', true)).toBe(true);
    expect(ifNoneMatchAllowsCreate('*', false)).toBe(true);
    expect(ifNoneMatchAllowsCreate('*', true)).toBe(false);
  });
});
