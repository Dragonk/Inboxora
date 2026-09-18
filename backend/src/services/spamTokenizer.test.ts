import { describe, expect, it } from 'vitest';
import { tokenize, extractFlagFeatures, cleanText, tokenFingerprint, EXECUTABLE_EXTENSIONS } from './spamTokenizer.js';

describe('spam tokenizer', () => {
  it('weights the subject and strips HTML bodies', () => {
    const tokens = tokenize({ subject: 'Free prize winner', bodyHtml: '<p>Click here to claim</p>' });
    expect(tokens).toContain('prize');
    expect(tokens).toContain('claim');
    expect(tokens.filter(t => t === 'prize').length).toBeGreaterThanOrEqual(2);
  });

  it('drops stop-words, numerics and single chars', () => {
    const tokens = tokenize({ subject: 'The a 123 x', body: 'and the 42 z' });
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('and');
    expect(tokens).not.toContain('123');
    expect(tokens).not.toContain('x');
  });

  it('extracts URL hosts as tokens', () => {
    const tokens = tokenize({ subject: 'deal', body: 'visit https://bit.ly/abc now' });
    expect(tokens).toContain('bit.ly');
  });

  it('caps pathological inputs', () => {
    const huge = 'w '.repeat(100000);
    const tokens = tokenize({ subject: huge, body: huge });
    expect(tokens.length).toBeLessThanOrEqual(2000);
  });

  it('strips script contents from HTML', () => {
    expect(cleanText('<script>evil()</script><p>hello</p>')).toBe('hello');
  });

  it('extracts attachment and mismatch flags', () => {
    const flags = extractFlagFeatures({
      subject: 'Hi',
      from: 'a@example.com',
      replyTo: 'b@other.com',
      attachments: [{ filename: 'invoice.pdf.exe' }],
      headers: [],
    });
    expect(flags.has_attachment).toBe(1);
    expect(flags.attachment_is_executable).toBe(1);
    expect(flags.from_equals_reply_to_mismatch).toBe(1);
  });

  it('keeps executable list non-empty and stable', () => {
    expect(EXECUTABLE_EXTENSIONS.has('exe')).toBe(true);
    expect(EXECUTABLE_EXTENSIONS.has('pdf')).toBe(false);
  });

  it('produces stable fingerprints', () => {
    const msg = { subject: 'Free prize', body: 'claim now' };
    expect(tokenFingerprint(msg)).toBe(tokenFingerprint(msg));
  });
});
