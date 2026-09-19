import { describe, expect, it } from 'vitest';
import { requestTooLargeMessage } from './errors.js';

describe('requestTooLargeMessage', () => {
  it('names the import limit for an import route, not the attachment limit', () => {
    // The message must describe what the user was doing: a .vcf upload has no
    // attachments, so an attachment limit would be misleading.
    expect(requestTooLargeMessage('/api/contacts/address-books/book-1/import/vcard')).toContain('900 KB');
    expect(requestTooLargeMessage('/api/contacts/address-books/book-1/import/google-csv')).toContain('900 KB');
    expect(requestTooLargeMessage('/api/calendar/calendars/cal-1/import/ics')).toContain('900 KB');
  });

  it('states the send route’s own window rather than a transport’s attachment limit', () => {
    // The send route's window is the installation's hard attachment ceiling carried as base64; which transport
    // ceiling applies is decided later, per account, and reported by the route with its own domain code. Naming
    // "25 MB of attachments" here would be the old global number that no longer bounds every transport.
    const send = requestTooLargeMessage('/api/mail/send');
    expect(send).toMatch(/\d+ MB/);
    expect(Number(send.match(/(\d+) MB/)?.[1])).toBeGreaterThanOrEqual(150);
    expect(send).not.toContain('25 MB');
    // A draft carries no attachments, so this one names the draft rather than an attachment limit.
    expect(requestTooLargeMessage('/api/mail/draft')).toContain('draft');
  });

  it('stays generic everywhere else instead of naming the wrong thing', () => {
    expect(requestTooLargeMessage('/api/contacts')).toBe('Request too large.');
    // The pet import is a file upload too, but with its own (larger) limit.
    expect(requestTooLargeMessage('/api/gtd/pet/import')).toContain('5 MB');
    expect(requestTooLargeMessage('')).toBe('Request too large.');
  });
});
