import { describe, expect, it } from 'vitest';
import { normalizeMessageId, normalizeMessageIdList } from './normalizeMessageId.js';
import { parseThreadHeaders } from './parseThreadHeaders.js';
import { buildThreadGraph, findThreadRoot } from './threadGraph.js';
import { computeThreadKey, normalizedSubject } from './threadingEngine.js';

describe('threading foundation', () => {
  it('preserves opaque Message-ID case and rejects internal whitespace', () => {
    expect(normalizeMessageId('  <ABC@Example.COM>  ')).toBe('<ABC@Example.COM>');
    expect(normalizeMessageId('<a b@x>')).toBeNull();
  });

  it('deduplicates message ids without silently replacing the first record', () => {
    const graph = buildThreadGraph([
      { messageId: '<same@x>', subject: 'first' },
      { messageId: '<same@x>', subject: 'duplicate' },
    ]);
    expect(graph.nodes.get('<same@x>').subject).toBe('first');
    expect(graph.duplicates).toHaveLength(1);
  });

  it('preserves case in distinct opaque ids', () => {
    expect(normalizeMessageIdList('<a@x> <A@X> <b@x>')).toEqual(['<a@x>', '<A@X>', '<b@x>']);
  });

  it('parses folded references and in-reply-to headers', () => {
    const parsed = parseThreadHeaders({
      References: '<root@example>\n <reply@example>',
      'In-Reply-To': '<reply@example>',
    });
    expect(parsed.references).toEqual(['<root@example>', '<reply@example>']);
    expect(parsed.inReplyTo).toBe('<reply@example>');
  });

  it('walks the parent chain to the root and stops at missing parents', () => {
    const graph = buildThreadGraph([
      { messageId: '<root@x>' },
      { messageId: '<reply@x>', inReplyTo: '<root@x>' },
      { messageId: '<latest@x>', inReplyTo: '<reply@x>' },
    ]);
    expect(findThreadRoot('<latest@x>', graph)).toBe('<root@x>');
    expect(computeThreadKey({ messageId: '<latest@x>', inReplyTo: '<unknown@x>' }, [
      { messageId: '<latest@x>', inReplyTo: '<unknown@x>' },
    ])).toBe('<latest@x>');
  });

  it('does not merge independent messages using subject alone', () => {
    expect(normalizedSubject('Re: FWD:  Project Update ')).toBe('project update');
    expect(computeThreadKey({ subject: 'RE: Project Update' })).toBeNull();
  });
});
