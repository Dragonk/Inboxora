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

  it('keeps the attachment wording where attachments are what is being sent', () => {
    expect(requestTooLargeMessage('/api/mail/send')).toContain('attachment');
    expect(requestTooLargeMessage('/api/mail/draft')).toContain('attachment');
  });

  it('stays generic everywhere else instead of naming the wrong thing', () => {
    expect(requestTooLargeMessage('/api/contacts')).toBe('Request too large.');
    // The pet import is a file upload too, but with its own (larger) limit.
    expect(requestTooLargeMessage('/api/gtd/pet/import')).toContain('5 MB');
    expect(requestTooLargeMessage('')).toBe('Request too large.');
  });
});
