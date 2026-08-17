import { describe, expect, it } from 'vitest';
import { buildThreadGraph } from './threadGraph.js';

// Deterministic fixtures for legacy subject-only rows and out-of-order delivery.
describe('legacy conversation fixtures', () => {
  it('does not create an RFC parent from identical subjects alone', () => {
    const graph = buildThreadGraph([
      { messageId: '<a@test>', subject: 'Test' },
      { messageId: '<b@test>', subject: 'Re: Test' },
    ]);
    expect(graph.parentById.size).toBe(0);
  });

  it('keeps an unresolved child detached until its parent is available', () => {
    const graph = buildThreadGraph([{ messageId: '<child@test>', inReplyTo: '<missing@test>' }]);
    expect(graph.parentById.get('<child@test>')).toBe('<missing@test>');
  });
});
