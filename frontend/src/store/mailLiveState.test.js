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

test('a deleted selected account falls back to all inboxes and releases cached messages', () => {
  seed();
  useStore.setState({ selectedAccountId: 'deleted', selectedFolder: 'Sent', folders: { deleted: [{ path: 'Sent' }], active: [{ path: 'INBOX' }] }, showCalendar: false });
  useStore.getState().setAccounts([{ id: 'active' }]);
  assert.equal(useStore.getState().selectedAccountId, null);
  assert.equal(useStore.getState().selectedFolder, 'INBOX');
  assert.deepEqual(useStore.getState().folders, { active: [{ path: 'INBOX' }] });
  assert.deepEqual(useStore.getState().messages, []);
});
test('an unavailable account list cannot clear an existing selection', () => {
  seed(); useStore.setState({ selectedAccountId: 'active' });
  useStore.getState().setAccounts(undefined);
  assert.equal(useStore.getState().selectedAccountId, 'active');
});

test('a late unread-count response cannot overwrite a newer response or an optimistic read', async () => {
  const { api } = await import('../utils/api.js');
  const { refreshUnreadCounts } = await import('../utils/unreadRefresh.js');
  const original = api.getUnreadCounts;
  const resolvers = [];
  api.getUnreadCounts = () => new Promise(resolve => resolvers.push(resolve));
  try {
    useStore.setState({ accounts: [{ id: 'a', enabled: true }], unreadCounts: { total: 3, byAccount: { a: 3 } } });
    const old = refreshUnreadCounts(); const recent = refreshUnreadCounts();
    resolvers[1]({ total: 2, byAccount: { a: 2 } }); await recent;
    resolvers[0]({ total: 3, byAccount: { a: 3 } }); await old;
    assert.equal(useStore.getState().unreadCounts.total, 2);
    const beforeRead = refreshUnreadCounts();
    useStore.getState().decrementUnread('a');
    resolvers[2]({ total: 2, byAccount: { a: 2 } }); await beforeRead;
    assert.equal(useStore.getState().unreadCounts.total, 1);
  } finally { api.getUnreadCounts = original; }
});
