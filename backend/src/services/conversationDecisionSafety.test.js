import { describe, expect, it } from 'vitest';
import { canonicalConversationSubject, classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';
import { strictSeriesDecision, smartSeriesDecision } from './automatedSeries.js';

describe('conversation v2 decision safety', () => {
  it('keeps forwards distinct from reply subject normalization', () => {
    expect(canonicalConversationSubject('Re: Project')).toBe('project');
    expect(canonicalConversationSubject('Fwd: Project')).toBe('fwd: project');
  });

  it('does not merge by subject alone', () => {
    const decision = threadingDecision({ message: { subject: 'Same subject' }, parent: null });
    expect(decision.reason).toBe('new-root');
  });

  it('includes aliases in direction identity and keeps ids user-scoped', () => {
    expect(classifyDirection({ from_email: 'alias@example.com', to_addresses: [] }, ['me@example.com', 'alias@example.com'])).toBe('self');
    expect(logicalMessageIdentity({ message_id: '<m@x>', date: '2026-01-01', subject: 'x' }, { userId: 'u1' }).canonicalMessageId).toBe('<m@x>');
  });

  it('requires explicit smart-series enablement', () => {
    const base = { canonical_subject: 'notice', from_email: 'no-reply@example.com', headers: { 'auto-submitted': 'auto-generated', 'authentication-results': 'example.com; dkim=pass; spf=pass; dmarc=pass' }, to_addresses: [{ email: 'me@example.com' }], body_text: 'hello 1234', date: '2026-01-01T00:00:00Z', referencesAnchor: '<anchor@example.test>' };
    expect(smartSeriesDecision({ message: base, previous: base, enabled: false })).toBeNull();
    expect(strictSeriesDecision({ message: base, previous: base }).kind).toBe('automated_reference_series');
  });
});
