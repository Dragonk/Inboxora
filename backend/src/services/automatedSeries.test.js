import { describe, expect, it } from 'vitest';
import { bodyTemplateFingerprint, smartSeriesDecision, strictSeriesDecision } from './automatedSeries.js';

const base = {
  headers: { 'auto-submitted': 'auto-generated', 'authentication-results': 'example.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass' },
  from_email: 'noreply@example.com',
  to_addresses: [{ email: 'me@example.com' }], canonical_subject: 'security alert',
  received_at: '2026-01-01T00:00:00Z', body_text: 'Your code is 123456', referencesAnchor: '<anchor>',
};

describe('automated series', () => {
  it('uses a rolling seven-day strict window and no artificial parent', () => {
    const result = strictSeriesDecision({ message: { ...base, received_at: '2026-01-07T00:00:00Z' }, previous: { ...base, logical_message_count: 2 } });
    expect(result.kind).toBe('automated_reference_series');
    expect(result.parentLogicalMessageId).toBeNull();
  });

  it('does not strict-merge generic subjects or different anchors', () => {
    expect(strictSeriesDecision({ message: { ...base, canonical_subject: 'test' }, previous: base })).toBeNull();
    expect(strictSeriesDecision({ message: { ...base, referencesAnchor: '<other>' }, previous: base })).toBeNull();
  });

  it('covers strict anchor negatives, smart OTP positives/negatives, and off mode', () => {
    expect(strictSeriesDecision({ message: { ...base, referencesAnchor: null }, previous: base })).toBeNull();
    expect(strictSeriesDecision({ message: { ...base, referencesAnchor: '<other>' }, previous: base })).toBeNull();
    expect(smartSeriesDecision({ message: base, previous: base, enabled: true })?.kind).toBe('automated_smart_series');
    expect(smartSeriesDecision({ message: base, previous: base, enabled: false })).toBeNull();
    expect(bodyTemplateFingerprint('Your code is 123456')).toBe(bodyTemplateFingerprint('Your code is 654321'));
  });

  // P1-14: STRICT must require authenticated sender evidence (DKIM/SPF/DMARC).
  // Self-declared Auto-Submitted/Precedence/no-reply are NOT sufficient.
  it('rejects STRICT merge without authenticated sender evidence (forged-header negative)', () => {
    const forged = { ...base, headers: { 'auto-submitted': 'auto-generated', precedence: 'bulk' } };
    // No authentication-results header → no auth evidence → STRICT must reject.
    expect(strictSeriesDecision({ message: forged, previous: base })).toBeNull();
    expect(strictSeriesDecision({ message: base, previous: forged })).toBeNull();
    // Self-declared no-reply without auth evidence → rejected.
    const noReply = { ...base, headers: { 'auto-submitted': 'auto-generated' }, from_email: 'no-reply@attacker.com' };
    expect(strictSeriesDecision({ message: noReply, previous: noReply })).toBeNull();
  });
});
