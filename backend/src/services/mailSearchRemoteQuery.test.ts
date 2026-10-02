import { describe, expect, it } from 'vitest';
import { gmailSearchQuery, graphSearchQuery, imapSearchQuery, searchDate } from './mailSearchRemoteQuery.js';

describe('provider search grammar', () => {
  it('keeps repeated IMAP operators conjunctive and free phrases literal', () => {
    expect(imapSearchQuery('from:alice from:bob "invoice 100%"')).toEqual({ not: { or: [
      { not: { text: 'invoice 100%' } }, { not: { from:'alice' } }, { not: { from:'bob' } },
    ] } });
    expect(imapSearchQuery('-"do not match"')).toEqual({not:{text:'do not match'}});
  });
  it('compiles Gmail syntax without letting quotes inject extra operators', () => {
    expect(gmailSearchQuery('subject:"from:alice newsletter"')).toBe('subject:"from:alice newsletter"');
    expect(gmailSearchQuery('to:"Jane Smith"')).toBe('{to:"jane smith" cc:"jane smith"}');
    expect(gmailSearchQuery('has:attachment is:unread')).toBe('has:attachment is:unread');
  });
  it('uses exact epoch boundaries for Gmail, widened before the local date check', () => {
    expect(gmailSearchQuery('after:2026-09-30T12:30:00+02:00')).toBe(`after:${Date.parse('2026-09-30T12:30:00+02:00') / 1000 - 1}`);
    expect(searchDate('2026-09-30t12:30:00z').toISOString()).toBe('2026-09-30T12:30:00.000Z');
    expect(() => searchDate('2026-02-30')).toThrow('Invalid search date');
    expect(() => searchDate('2026-02-30T12:00:00Z')).toThrow('Invalid search date');
    expect(() => searchDate('yesterday')).toThrow();
  });
  it('does not confuse IMAP internal dates with the Date header searched locally', () => {
    expect(imapSearchQuery('after:2026-01-01 before:2026-03-01')).toEqual({all:true});
  });
  it('searches Graph recipients as well as default from/subject/body fields', () => {
    expect(graphSearchQuery('receipt')).toContain('to:"receipt" OR cc:"receipt"');
    expect(graphSearchQuery('to:alice -subject:spam')).toBe('(to:"alice" OR cc:"alice") AND NOT subject:"spam"');
  });
});
