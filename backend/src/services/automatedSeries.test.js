import { describe, expect, it } from 'vitest';
import { bodyTemplateFingerprint, smartSeriesDecision, strictSeriesDecision } from './automatedSeries.js';

const base = {
  headers: { 'auto-submitted': 'auto-generated' }, from_email: 'noreply@example.com',
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

  it('keeps smart series behind an explicit flag and bounded window', () => {
    expect(smartSeriesDecision({ message: base, previous: base, enabled: false })).toBeNull();
    expect(smartSeriesDecision({ message: { ...base, received_at: '2026-01-04T00:00:00Z' }, previous: base, enabled: true }).kind).toBe('automated_smart_series');
    expect(bodyTemplateFingerprint('Your code is 123456')).toBe(bodyTemplateFingerprint('Your code is 654321'));
  });
});
