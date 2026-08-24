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

  it('uses delivery identities for direction without treating Sender as From', () => {
    expect(classifyDirection({
      from_email: 'sender@example.net',
      sender_email: 'via@example.net',
      to_addresses: [],
      delivery_addresses: [{ email: 'catchall@example.com' }],
    }, ['me@example.com', 'catchall@example.com'])).toBe('incoming');
    expect(classifyDirection({
      from_email: 'catchall@example.com',
      sender_email: 'via@example.net',
      to_addresses: [{ email: 'external@example.net' }],
      delivery_addresses: [],
    }, ['me@example.com', 'catchall@example.com'])).toBe('outgoing');
  });

  it('keeps unrelated identical subjects as independent new roots without evidence', () => {
    const decisions = Array.from({ length: 100 }, (_, index) => threadingDecision({
      message: {
        message_id: `<test-${index}@example.test>`,
        subject: index % 2 ? 'Re: Test' : 'Test',
        from_email: `sender-${index}@example.test`,
      },
      parent: null,
      provider: null,
      identities: ['me@example.test'],
    }));
    expect(decisions).toHaveLength(100);
    expect(new Set(decisions.map(decision => decision.reason))).toEqual(new Set(['new-root']));
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
