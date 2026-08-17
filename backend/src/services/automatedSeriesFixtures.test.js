import { describe, expect, it } from 'vitest';
import { strictSeriesDecision, smartSeriesDecision } from './automatedSeries.js';

describe('automated series fixtures', () => {
  const base = { canonical_subject: 'Daily digest', from_email: 'no-reply@example.test', headers: { 'auto-submitted': 'auto-generated' }, to_addresses: [{ email: 'me@example.test' }], date: '2026-01-01T00:00:00Z', received_at: '2026-01-01T00:00:00Z', body_text: 'Hello 1234', referencesAnchor: '<daily-digest@example.test>' };
  it('requires matching automation signatures in strict mode', () => {
    expect(strictSeriesDecision({ message: base, previous: { ...base, from_email: 'other@example.test' } })).toBeNull();
    expect(strictSeriesDecision({ message: base, previous: base })?.kind).toBe('automated_reference_series');
  });
  it('keeps smart series explicitly disabled by default', () => {
    expect(smartSeriesDecision({ message: base, previous: base })).toBeNull();
  });
});
