import { describe, it, expect } from 'vitest';
import { stripHeaderFromMessage } from './mimeHeaders.js';

// Removing a header from a composed message is a small function with a large blast radius:
// it runs on the buffer that a transport may send verbatim, so every case here is about
// what must NOT change as much as about the header that must go.
describe('stripHeaderFromMessage', () => {
  const msg = (head: string, body = 'Body text\r\nBcc: not a header here\r\n') => `${head}\r\n\r\n${body}`;

  it('removes the header and its folded continuation, keeping the message otherwise intact', () => {
    const input = msg('From: sam@x.test\r\nBcc: blind@x.test,\r\n more@x.test\r\nSubject: Hi');
    const out = stripHeaderFromMessage(input, 'Bcc').toString();
    expect(out).toBe(msg('From: sam@x.test\r\nSubject: Hi'));
    expect(out).not.toContain('blind@x.test');
    expect(out).not.toContain('more@x.test');
  });

  it('removes it wherever it sits, including last, and matches the name case-insensitively', () => {
    const last = msg('From: sam@x.test\r\nSUBJECT: Hi\r\nbcc: blind@x.test');
    expect(stripHeaderFromMessage(last, 'Bcc').toString()).toBe(msg('From: sam@x.test\r\nSUBJECT: Hi'));
  });

  it('never touches the body, even when a body line starts with the header name', () => {
    const input = msg('From: sam@x.test\r\nBcc: blind@x.test\r\nSubject: Hi');
    const out = stripHeaderFromMessage(input, 'Bcc').toString();
    // The body's own "Bcc:" line is content, not a header, and survives.
    expect(out).toContain('Body text\r\nBcc: not a header here\r\n');
  });

  it('returns the identical bytes when there is nothing to remove', () => {
    const input = Buffer.from(msg('From: sam@x.test\r\nSubject: Hi'), 'utf8');
    const out = stripHeaderFromMessage(input, 'Bcc');
    expect(out.equals(input)).toBe(true);
  });

  it('leaves a buffer with no header separator alone rather than guessing', () => {
    const input = Buffer.from('not a message', 'utf8');
    expect(stripHeaderFromMessage(input, 'Bcc').equals(input)).toBe(true);
  });
});
