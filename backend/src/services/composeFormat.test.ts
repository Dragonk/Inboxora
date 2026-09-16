import { describe, expect, it } from 'vitest';
import { resolveOutgoingBodyIsHtml } from './composeFormat.js';

describe('resolveOutgoingBodyIsHtml', () => {
  it('keeps an explicit HTML or plaintext composition independent of profile preference', () => {
    expect(resolveOutgoingBodyIsHtml(true, true)).toBe(true);
    expect(resolveOutgoingBodyIsHtml(true, false)).toBe(true);
    expect(resolveOutgoingBodyIsHtml(false, true)).toBe(false);
    expect(resolveOutgoingBodyIsHtml(false, false)).toBe(false);
  });

  it('uses the legacy profile preference only when the API field is absent', () => {
    expect(resolveOutgoingBodyIsHtml(undefined, true)).toBe(false);
    expect(resolveOutgoingBodyIsHtml(undefined, false)).toBe(true);
  });
});
