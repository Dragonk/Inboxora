import { describe, expect, it } from 'vitest';
import { canonicalConversationSubject, classifyDirection, logicalMessageIdentity, threadingDecision } from './conversationEngine.js';

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

  it('deduplicates folder copies inside one account but separates managed accounts', () => {
    const common = {
      message_id: '<m1@test>', subject: 'Testowy mail', from_email: 'a@example.test',
      date: '2026-08-25T11:42:00.000Z', in_reply_to: null, thread_references: null,
    };
    expect(logicalMessageIdentity({ ...common, body_text: 'Inbox wrapper' }, { userId: 'user-1', accountId: 'account-a' }).collisionKey)
      .toBe(logicalMessageIdentity({ ...common, body_text: 'Sent wrapper with provider footer' }, { userId: 'user-1', accountId: 'account-a' }).collisionKey);
    expect(logicalMessageIdentity({ ...common, from_email: 'collision@example.test' }, { userId: 'user-1', accountId: 'account-a' }).collisionKey)
      .not.toBe(logicalMessageIdentity(common, { userId: 'user-1', accountId: 'account-a' }).collisionKey);
    expect(logicalMessageIdentity({ ...common, thread_references: '<earlier@test>' }, { userId: 'user-1', accountId: 'account-a' }).collisionKey)
      .toBe(logicalMessageIdentity({ ...common, thread_references: null }, { userId: 'user-1', accountId: 'account-a' }).collisionKey);
    // Account locality is the persistence namespace; the stable collision discriminator
    // intentionally remains the same so existing identities can be reused after migration.
    expect(logicalMessageIdentity(common, { userId: 'user-1', accountId: 'account-a' }).collisionKey)
      .toBe(logicalMessageIdentity(common, { userId: 'user-1', accountId: 'account-b' }).collisionKey);
  });

  it('uses the shared opaque Message-ID normalizer for canonical identity', () => {
    expect(logicalMessageIdentity({ message_id: ' <ABC@EXAMPLE> ' }, { userId: 'user-1' }).canonicalMessageId).toBe('<ABC@EXAMPLE>');
    expect(logicalMessageIdentity({ message_id: '<broken id>' }, { userId: 'user-1' }).canonicalMessageId).toBeNull();
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

  it('keeps an unambiguous RFC parent authoritative across a subject change', () => {
    const result = threadingDecision({
      message: { message_id: '<child>', subject: 'New Topic' },
      parent: { message_id: '<parent>', subject: 'Old Topic' },
      userId: 'u1',
    });
    expect(result.reason).toBe('rfc-in-reply-to');
    expect(result.kind).toBe('human_reply_chain');
    expect(result.subjectChanged).toBe(true);
  });
});
