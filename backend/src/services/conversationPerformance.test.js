import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { canonicalConversationSubject } from './conversationEngine.js';

describe('conversation performance contract', () => {
  it('canonicalizes a bounded batch without pathological slowdown', () => {
    const subjects = Array.from({ length: 1000 }, (_, i) => `Re: Message ${i}`);
    const start = performance.now();
    const result = subjects.map(canonicalConversationSubject);
    expect(result).toHaveLength(1000);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
