import { describe, expect, it } from 'vitest';
import { strictSeriesDecision, smartSeriesDecision } from './automatedSeries.js';
import { parseProviderMetadata } from './providerThreadAdapter.js';

const base = { canonical_subject: 'Security alert', from_email: 'no-reply@example.test', to_addresses: [{ email: 'me@example.test' }], date: '2026-01-01T00:00:00Z', body_text: 'Alert 1000' };

describe('provider and automated-series fixtures', () => {
  it.each([
    ['gmail', { imap_host: 'imap.gmail.com' }, { xGmThrid: 123n }],
    ['outlook', { imap_host: 'outlook.office365.com' }, {}],
    ['generic', { imap_host: 'imap.fastmail.com' }, {}],
  ])('discovers %s provider without secrets', (provider, account, attributes) => {
    expect(parseProviderMetadata({ attributes }, { id: 'a1', ...account }).provider).toBe(provider);
  });

  it('keeps strict and smart automated series opt-in and safe', () => {
    const automated = { ...base, headers: { 'auto-submitted': 'auto-generated' } };
    const anchored = { ...automated, referencesAnchor: '<security-anchor@example.test>', received_at: '2026-01-01T00:00:00Z' };
    expect(strictSeriesDecision({ message: { ...anchored, date: '2026-01-02T00:00:00Z', received_at: '2026-01-02T00:00:00Z' }, previous: anchored })?.kind).toBe('automated_reference_series');
    expect(smartSeriesDecision({ message: { ...automated, date: '2026-01-02T00:00:00Z' }, previous: automated, enabled: false })).toBeNull();
  });
});
