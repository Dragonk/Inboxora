import assert from 'node:assert/strict';
import test from 'node:test';

Reflect.set(globalThis, 'localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { createPostSendRefreshManager } = await import('./postSendRefresh.ts');

type Timer = { callback: () => void; cleared: boolean };

function createHarness() {
  let epoch = 1;
  const listeners = new Set<(epoch: number) => void>();
  const timers: Timer[] = [];
  const threadCalls: string[] = [];
  const threadWrites: Array<{ cacheId: string; messages: string[] }> = [];
  const conversations: string[] = [];
  const manager = createPostSendRefreshManager<string>({
    getAuthEpoch: () => epoch,
    isCurrentAuthEpoch: candidate => candidate === epoch,
    onAuthEpochChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getThread: async (threadId) => { threadCalls.push(threadId); return { messages: ['sent-copy'] }; },
    setThreadMessages: (cacheId, messages) => threadWrites.push({ cacheId, messages }),
    refreshConversation: id => conversations.push(id),
    setTimer: callback => { const timer = { callback, cleared: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: timer => { (timer as unknown as Timer).cleared = true; },
  });
  return { manager, timers, threadCalls, threadWrites, conversations, advanceEpoch: () => { epoch += 1; listeners.forEach(listener => listener(epoch)); } };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('post-send refresh survives normal compose unmount ownership', async () => {
  const harness = createHarness();
  harness.manager.schedule({ accountId: 'account-a', threadId: 'thread-a', threadCacheId: 'cache-a', conversationId: 'conversation-a' });
  await flush();
  assert.deepEqual(harness.threadCalls, ['thread-a']);
  assert.deepEqual(harness.conversations, ['conversation-a']);

  // No dispose occurs when ComposeModal closes, so the manager-owned timer still runs.
  harness.timers[0].callback();
  await flush();
  assert.deepEqual(harness.threadCalls, ['thread-a', 'thread-a']);
  assert.deepEqual(harness.threadWrites, [
    { cacheId: 'cache-a', messages: ['sent-copy'] },
    { cacheId: 'cache-a', messages: ['sent-copy'] },
  ]);
});

test('auth generation changes cancel delayed refreshes and reject stale results', async () => {
  const harness = createHarness();
  harness.manager.schedule({ accountId: 'account-a', threadId: 'thread-a', threadCacheId: 'cache-a' });
  harness.advanceEpoch();
  assert.ok(harness.timers.every(timer => timer.cleared));

  for (const timer of harness.timers) if (!timer.cleared) timer.callback();
  await flush();
  assert.deepEqual(harness.threadWrites, []);
});
