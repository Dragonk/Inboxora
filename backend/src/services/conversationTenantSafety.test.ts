import { describe, expect, it } from 'vitest';
import { classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';

describe('conversation tenant and identity safety', () => {
  it('keeps canonical identity case-sensitive and user-scoped', () => {
    expect(logicalMessageIdentity({ message_id: '<ABC@EXAMPLE>', date: '2026-01-01' }, { userId: 'u1' }).canonicalMessageId).toBe('<ABC@EXAMPLE>');
    expect(logicalMessageIdentity({ message_id: '<ABC@EXAMPLE>', date: '2026-01-01' }, { userId: 'u2' }).collisionKey).not.toBe(logicalMessageIdentity({ message_id: '<ABC@EXAMPLE>', date: '2026-01-01' }, { userId: 'u1' }).collisionKey);
  });

  it('does not infer a human merge from subject without a parent', () => {
    expect(threadingDecision({ message: { subject: 'Re: Test' }, parent: null }).reason).toBe('new-root');
  });

  it('classifies aliases and outgoing replies without crossing recipient ownership', () => {
    expect(classifyDirection({ from_email: 'alias@example.test', to_addresses: [{ email: 'other@example.test' }] }, ['alias@example.test'])).toBe('outgoing');
  });
});
