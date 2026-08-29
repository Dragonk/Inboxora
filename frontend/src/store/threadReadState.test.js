import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { normalizedNativeThreadMembers } from '../utils/nativeThreadMembership.js';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useStore } = await import('./index.js');

describe('thread row read-state synchronization', () => {
  beforeEach(() => {
    useStore.setState({ messages: [], searchResults: [], threadMessages: {} });
  });

  it('updates the parent row after a child read when thread_key and thread_id differ', () => {
    useStore.setState({
      messages: [{ id: 'row-1', thread_id: 'thread-id-1', thread_key: 'provider-thread-key', unread_count: 1, is_read: false }],
      threadMessages: {
        'thread-id-1': normalizedNativeThreadMembers([
          { id: 'child-read', is_read: true },
          { id: 'child-unread', message_id: '<unread@example.test>', is_read: false },
          { id: 'child-unread-duplicate', message_id: '<unread@example.test>', is_read: false },
        ]),
      },
    });

    useStore.getState().updateMessage('child-unread', { is_read: true });

    const { messages, threadMessages } = useStore.getState();
    assert.equal(messages[0].unread_count, 0);
    assert.equal(messages[0].is_read, true);
    assert.equal(threadMessages['thread-id-1'].length, 2);
    assert.equal(threadMessages['thread-id-1'][1].is_read, true);
    assert.equal(threadMessages['provider-thread-key'], undefined);
  });
});