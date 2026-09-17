import { describe, expect, it } from 'vitest';
import { resolveIncomingBodyIsHtml, resolveOutgoingBodyIsHtml } from './composeFormat.js';

describe('compose format contract', () => {
  it('keeps an omitted legacy body literal while allowing profile-selected HTML MIME', () => {
    expect(resolveIncomingBodyIsHtml(undefined)).toBe(false);
    expect(resolveOutgoingBodyIsHtml(undefined, false)).toBe(true);
    expect(resolveOutgoingBodyIsHtml(undefined, true)).toBe(false);
  });
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
