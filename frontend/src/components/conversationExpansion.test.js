import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialConversationExpansion, initialConversationTarget, toggleConversationExpansion } from './conversationExpansion.js';

const messages = [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }];

describe('conversation expansion policy', () => {
  it('initially expands only the selected message in a three-message conversation', () => {
    const expanded = initialConversationExpansion(messages, 'M2');
    assert.equal(expanded.size, 1);
    assert.equal(expanded.has('M2'), true);
  });

  it('falls back to the newest message only when the target is stale', () => {
    assert.equal(initialConversationTarget(messages, 'stale'), 'M3');
    assert.deepEqual([...initialConversationExpansion(messages, 'stale')], ['M3']);
  });

  it('allows a collapsed older message and the selected message to stay expanded', () => {
    const selected = initialConversationExpansion(messages, 'M3');
    const expanded = toggleConversationExpansion(selected, 'M1');
    assert.deepEqual([...expanded], ['M3', 'M1']);
  });

  it('collapsing the selected message leaves another expanded message open', () => {
    let expanded = initialConversationExpansion(messages, 'M3');
    expanded = toggleConversationExpansion(expanded, 'M1');
    expanded = toggleConversationExpansion(expanded, 'M3');
    assert.deepEqual([...expanded], ['M1']);
  });

  it('allows every card to be manually collapsed', () => {
    let expanded = initialConversationExpansion(messages, 'M3');
    expanded = toggleConversationExpansion(expanded, 'M1');
    expanded = toggleConversationExpansion(expanded, 'M3');
    expanded = toggleConversationExpansion(expanded, 'M1');
    assert.equal(expanded.size, 0);
  });
});
