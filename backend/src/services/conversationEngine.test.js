import { describe, expect, it } from 'vitest';
import { canonicalConversationSubject, classifyDirection, threadingDecision } from './conversationEngine.js';

describe('Conversation Engine v2 primitives', () => {
  it('removes reply prefixes but keeps forward prefixes', () => {
    expect(canonicalConversationSubject('Re: Odp: Project Update')).toBe('project update');
    expect(canonicalConversationSubject('Fwd: Project Update')).toBe('fwd: project update');
  });

  it('classifies incoming, outgoing and self messages using identities', () => {
    const ids = ['me@example.com'];
    expect(classifyDirection({ from_email: 'other@example.com', to_addresses: [{ email: 'me@example.com' }] }, ids)).toBe('incoming');
    expect(classifyDirection({ from_email: 'me@example.com', to_addresses: [{ email: 'other@example.com' }] }, ids)).toBe('outgoing');
    expect(classifyDirection({ from_email: 'me@example.com', to_addresses: [{ email: 'me@example.com' }] }, ids)).toBe('self');
  });

  it('splits a material subject change despite a strong RFC parent', () => {
    const result = threadingDecision({
      message: { message_id: '<child>', subject: 'New Topic' },
      parent: { message_id: '<parent>', subject: 'Old Topic' },
      userId: 'u1',
    });
    expect(result.reason).toBe('subject-change-split');
    expect(result.relatedParentMessageId).toBe('<parent>');
  });
});
