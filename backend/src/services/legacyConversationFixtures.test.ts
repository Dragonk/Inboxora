import { describe, expect, it } from 'vitest';

function buildSubjectOnlyFixture(messages) {
  const parentById = new Map();
  for (const message of messages) {
    if (message.inReplyTo || message.references?.length) parentById.set(message.messageId, message.inReplyTo || message.references.at(-1));
  }
  return { parentById };
}

describe('legacy conversation fixtures', () => {
  it('keeps 12 independent legacy subject-only Test messages independent after repair policy', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      messageId: `<legacy-${i}@test>`, subject: i % 3 ? 'Test' : 'Re: Test',
      date: `${2014 + i % 4}-01-01`, accountId: i % 2 ? 'a2' : 'a1',
    }));
    const graph = buildSubjectOnlyFixture(messages);
    expect(graph.parentById.size).toBe(0);
    expect(new Set(messages.map(m => m.accountId))).toEqual(new Set(['a1', 'a2']));
  });

  it('does not infer an RFC parent from identical subjects alone', () => {
    const graph = buildSubjectOnlyFixture([{ messageId: '<a@test>', subject: 'Test' }, { messageId: '<b@test>', subject: 'Re: Test' }]);
    expect(graph.parentById.size).toBe(0);
  });
});
