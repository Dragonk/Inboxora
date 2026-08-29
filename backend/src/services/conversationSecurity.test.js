import { describe, expect, it } from 'vitest';
import { canonicalConversationSubject } from './conversationEngine.js';

describe('conversation security gate', () => {
  it('keeps forward prefixes separate from reply subjects', () => {
    expect(canonicalConversationSubject('Fwd: Test')).toBe('fwd: test');
    expect(canonicalConversationSubject('Re: Test')).toBe('test');
  });
});
