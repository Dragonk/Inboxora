import { describe, expect, it } from 'vitest';
import {
  extractAuthResultHeaders, extractAuthservId, normalizeAuthservId,
  extractAuthservIds, hasTrustedAuthResults, parseAuthResults,
} from './spamParser.js';

const GMAIL = 'mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=sender@example.com; dmarc=pass header.from=example.com';

describe('spam auth parser', () => {
  it('extracts payloads from raw lines and maps', () => {
    expect(extractAuthResultHeaders([`Authentication-Results: ${GMAIL}`])).toHaveLength(1);
    expect(extractAuthResultHeaders({ 'authentication-results': GMAIL })).toHaveLength(1);
    expect(extractAuthResultHeaders(null)).toEqual([]);
  });

  it('extracts and normalizes authserv-id', () => {
    expect(extractAuthservId('mx.google.com; dkim=pass')).toBe('mx.google.com');
    expect(extractAuthservId('mx.google.com/1; dkim=pass')).toBe('mx.google.com');
    expect(normalizeAuthservId(' MX.Google.COM ')).toBe('mx.google.com');
    expect(normalizeAuthservId(null)).toBeNull();
  });

  it('trusts nothing by default', () => {
    const headers = [`Authentication-Results: evil.example; dkim=fail; spf=fail; dmarc=fail`];
    expect(parseAuthResults(headers, {})).toEqual({ dkim: null, spf: null, dmarc: null });
    expect(hasTrustedAuthResults(headers, null)).toBe(false);
  });

  it('honors only the trusted authserv-id', () => {
    const headers = [
      'Authentication-Results: evil.example; dkim=fail; spf=fail; dmarc=fail',
      `Authentication-Results: ${GMAIL}`,
    ];
    const parsed = parseAuthResults(headers, { trustedAuthservIds: 'mx.google.com' });
    expect(parsed).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
    expect(extractAuthservIds(headers)).toContain('evil.example');
    expect(hasTrustedAuthResults(headers, 'mx.google.com')).toBe(true);
  });

  it('lets pass win across signatures', () => {
    const headers = ['Authentication-Results: mx.example.com; dkim=fail header.d=a; dkim=pass header.d=b'];
    expect(parseAuthResults(headers, { trustedAuthservIds: 'mx.example.com' }).dkim).toBe('pass');
  });
});
