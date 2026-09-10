import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  return nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { useStore } = await import('./index.js');
function seed() {
  useStore.setState({ threadedView: true, selectedAccountId: null, selectedFolder: 'INBOX', showCalendar: true, showContacts: false, mobileSidebarOpen: true, messagesRefreshToken: 4, messagesOffset: 50, expandedThreadId: 'a:thread', searchResults: [],
    messages: [{ id: 'newest', thread_id: 'a:thread', account_id: 'a', message_count: 2, unread_count: 2, is_read: false }],
    threadMessages: { 'a:thread': [{ id: 'newest', is_read: false }, { id: 'older', is_read: false }] },
  });
}
test('individual reads include the representative copy and only the final read clears the thread', () => {
  seed();
  useStore.getState().updateMessage('newest', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 1);
  assert.equal(useStore.getState().messages[0].is_read, false);
  assert.equal(useStore.getState().threadMessages['a:thread'][0].is_read, true);
  useStore.getState().updateMessage('older', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 0);
  assert.equal(useStore.getState().messages[0].is_read, true);
  useStore.getState().updateMessage('older', { is_read: false });
  assert.equal(useStore.getState().messages[0].unread_count, 1);
});
test('explicit whole-thread optimistic actions retain their supplied aggregate', () => {
  seed();
  useStore.getState().updateMessage('newest', { is_read: true, unread_count: 0 });
  assert.equal(useStore.getState().messages[0].unread_count, 0);
  useStore.getState().updateMessage('older', { is_starred: true });
  assert.equal(useStore.getState().messages[0].unread_count, 0);
});
test('returning from another module retains the live list and closes the mobile drawer', () => {
  seed();
  useStore.getState().updateMessage('older', { is_read: true });
  const live = useStore.getState();
  live.setSelectedAccount(null);
  const returned = useStore.getState();
  assert.equal(returned.messages, live.messages);
  assert.equal(returned.threadMessages, live.threadMessages);
  assert.equal(returned.messagesOffset, 50);
  assert.equal(returned.messagesRefreshToken, 4);
  assert.equal(returned.expandedThreadId, 'a:thread');
  assert.equal(returned.mobileSidebarOpen, false);
  assert.equal(returned.showCalendar, false);
});
test('different accounts or folders discard the previous scope', () => {
  for (const [account, folder] of [['a', 'INBOX'], [null, 'Sent']]) {
    seed();
    useStore.getState().setSelectedAccount(account, folder);
    assert.equal(useStore.getState().messages.length, 0);
    assert.equal(useStore.getState().expandedThreadId, null);
    assert.deepEqual(useStore.getState().threadMessages, {});
    assert.equal(useStore.getState().messagesRefreshToken, 5);
  }
});

test('flat rows keep physical read flags even when the reader has cached their thread', () => {
  seed();
  useStore.setState({ threadedView: false, messages: [
    { id: 'newest', thread_id: 'a:thread', is_read: false },
    { id: 'older', thread_id: 'a:thread', is_read: false },
  ] });
  useStore.getState().updateMessage('newest', { is_read: true });
  assert.equal(useStore.getState().messages[0].is_read, true);
  assert.equal(useStore.getState().messages[1].is_read, false);
  assert.equal(useStore.getState().messages[0].unread_count, undefined);
});
