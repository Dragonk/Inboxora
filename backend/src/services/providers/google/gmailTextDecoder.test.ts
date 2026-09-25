import { describe, expect, it } from 'vitest';
import { decodeGmailText } from './gmailTextDecoder.js';

describe('decodeGmailText', () => {
  it('keeps valid UTF-8 unchanged when charset is missing', () => {
    const value = 'Zażółć gęślą jaźń — UTF-8';
    expect(decodeGmailText(Buffer.from(value, 'utf8'), null)).toBe(value);
  });

  it('honours declared ISO-8859-2', () => {
    const bytes = Buffer.from([0x5a, 0xb3, 0x6f]); // Zło in ISO-8859-2
    expect(decodeGmailText(bytes, 'ISO-8859-2')).toBe('Zło');
  });

  it('recovers Windows-1250 Polish text when charset is missing', () => {
    const bytes = Buffer.from('5a61bff3b3e62067ea9c6cb9206a619ff1', 'hex');
    expect(decodeGmailText(bytes, null)).toBe('Zażółć gęślą jaźń');
  });

  it('recovers ISO-8859-2 Polish text mislabeled as UTF-8', () => {
    const bytes = Buffer.from('5a61bff3b3e62067eab66cb1206a61bcf1', 'hex');
    expect(decodeGmailText(bytes, 'UTF-8')).toBe('Zażółć gęślą jaźń');
  });

  it('recovers high-byte content mislabeled as US-ASCII', () => {
    const bytes = Buffer.from('5a61bff3b3e6', 'hex');
    expect(decodeGmailText(bytes, 'US-ASCII')).toBe('Zażółć');
  });

  it('does not turn arbitrary valid UTF-8 into a legacy code page', () => {
    const value = '日本語 — Ελληνικά — русский';
    expect(decodeGmailText(Buffer.from(value, 'utf8'), undefined)).toBe(value);
  });
});
