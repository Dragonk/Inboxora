import { describe, expect, it } from 'vitest';

type LegacySubjectOnlyFixtureMessage = {
  readonly messageId: string;
  readonly subject: string;
  readonly date: string;
  readonly accountId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
};

function buildSubjectOnlyFixture(messages: readonly LegacySubjectOnlyFixtureMessage[]): {
  readonly parentById: Map<string, string>;
} {
  const parentById = new Map<string, string>();
  for (const message of messages) {
    if (message.inReplyTo) {
      parentById.set(message.messageId, message.inReplyTo);
      continue;
    }

    const lastReference = message.references.at(-1);
    if (lastReference) parentById.set(message.messageId, lastReference);
  }
  return { parentById };
}

describe('legacy conversation fixtures', () => {
  it('keeps 12 independent legacy subject-only Test messages independent after repair policy', () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      messageId: `<legacy-${i}@test>`,
      subject: i % 3 ? 'Test' : 'Re: Test',
      date: `${2014 + (i % 4)}-01-01`,
      accountId: i % 2 ? 'a2' : 'a1',
      inReplyTo: undefined,
      references: [],
    }));
    const graph = buildSubjectOnlyFixture(messages);
    expect(graph.parentById.size).toBe(0);
    expect(new Set(messages.map(m => m.accountId))).toEqual(new Set(['a1', 'a2']));
  });

  it('does not infer an RFC parent from identical subjects alone', () => {
    const graph = buildSubjectOnlyFixture([
      {
        messageId: '<a@test>',
        subject: 'Test',
        date: '2014-01-01',
        accountId: 'a1',
        inReplyTo: undefined,
        references: [],
      },
      {
        messageId: '<b@test>',
        subject: 'Re: Test',
        date: '2014-01-02',
        accountId: 'a1',
        inReplyTo: undefined,
        references: [],
      },
    ]);
    expect(graph.parentById.size).toBe(0);
  });
});
