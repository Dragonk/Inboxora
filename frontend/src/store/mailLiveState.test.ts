import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  return nextLoad(url, context);
} });
Reflect.set(globalThis, 'localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
const { useStore } = await import('./index.ts');
function seed() {
  useStore.setState({ threadedView: true, selectedAccountId: null, selectedFolder: 'INBOX', showCalendar: true, showContacts: false, mobileSidebarOpen: true, messagesRefreshToken: 4, messagesOffset: 50, expandedThreadId: 'a:thread', searchResults: [],
    messages: [{ id: 'newest', thread_id: 'a:thread', account_id: 'a', message_count: 2, unread_count: 2, is_read: false }],
    threadMessages: { 'a:thread': [{ id: 'newest', account_id: 'a', is_read: false }, { id: 'older', account_id: 'a', is_read: false }] },
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
type AccountScope = Parameters<ReturnType<typeof useStore.getState>['setSelectedAccount']>;

test('different accounts or folders discard the previous scope', () => {
  const scopes: AccountScope[] = [['a', 'INBOX'], [null, 'Sent']];
  for (const [account, folder] of scopes) {
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
    { id: 'newest', account_id: 'a', thread_id: 'a:thread', is_read: false },
    { id: 'older', account_id: 'a', thread_id: 'a:thread', is_read: false },
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
  const { api } = await import('../utils/api.ts');
  const { refreshUnreadCounts } = await import('../utils/unreadRefresh.ts');
  const original = api.getUnreadCounts;
  type UnreadCounts = Awaited<ReturnType<typeof api.getUnreadCounts>>;
  const resolvers: Array<(value: UnreadCounts | PromiseLike<UnreadCounts>) => void> = [];
  api.getUnreadCounts = () => new Promise<UnreadCounts>(resolve => resolvers.push(resolve));
  try {
    useStore.setState({
      user: { id: 'test-user' },
      isLocked: false,
      accounts: [{ id: 'a', enabled: true }],
      unreadCounts: { total: 3, byAccount: { a: 3 } },
    });
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

test('navigation snapshots are evicted by local changes, account changes, lock and logout', async () => {
  const { mailListCache } = await import('../utils/mailListCache.ts');
  const params = { limit: 50, offset: 0 };
  const populate = () => {
    mailListCache.finish(mailListCache.begin(params, 1), { messages: [{ id: 'newest', account_id: 'a' }], total: 1 });
    assert.ok(mailListCache.get(params, 1));
  };
  seed();
  for (const action of [
    () => useStore.getState().updateMessage('newest', { is_read: true }),
    () => useStore.getState().removeMessage('newest'),
    () => useStore.getState().removeMessages(['newest']),
    () => useStore.getState().restoreMessages([{ id: 'newest', account_id: 'a' }]),
    () => useStore.getState().setAccounts([{ id: 'a', enabled: true }]),
    () => useStore.getState().updateAccount('a', { include_in_unified_inbox: false }),
    () => useStore.getState().setLocked(true),
    () => { useStore.setState({ user: { id: 'old-user' } }); useStore.getState().setUser(null); },
  ]) {
    populate(); action(); assert.equal(mailListCache.get(params, 1), undefined);
  }
});

test('message mutations evict only complete affected scopes, including search and cached children', async () => {
  const { mailListCache } = await import('../utils/mailListCache.ts');
  const unified = { limit: 50, offset: 0 };
  const scopes = ['a', 'b', 'c'].map(accountId => ({ ...unified, accountId }));
  const a = { id: 'a-1', account_id: 'a' }, b = { id: 'b-1', account_id: 'b' }, c = { id: 'c-1', account_id: 'c' };
  const prepare = () => {
    seed();
    useStore.setState({ messages: [a], searchResults: [b], threadMessages: { c: [c] } });
    for (const params of [unified, ...scopes]) {
      const accountId = 'accountId' in params ? String(params.accountId) : 'a';
      mailListCache.finish(mailListCache.begin(params, 1), { messages: [{ id: `cached-${accountId}`, account_id: accountId }], total: 1 });
    }
  };
  const check = (evicted: string[]) => {
    assert.equal(mailListCache.get(unified, 1), undefined);
    for (const scope of scopes) assert.equal(Boolean(mailListCache.get(scope, 1)), !evicted.includes(scope.accountId));
  };
  prepare(); useStore.getState().updateMessage(a.id, { is_read: true }); check(['a']);
  prepare(); useStore.getState().removeMessage(b.id); check(['b']);
  prepare(); useStore.getState().removeMessages([a.id, c.id, c.id]); check(['a', 'c']);
  prepare(); useStore.getState().restoreMessages([{ ...a, id: 'restored-a' }, { ...b, id: 'restored-b' }]); check(['a', 'b']);
  prepare(); useStore.getState().restoreMessages([{ ...a, account_id: 'c' }]); check(['a', 'c']);
  prepare(); useStore.getState().updateMessage(a.id, { account_id: 'c' }); check(['a', 'c']);
  prepare(); useStore.getState().removeMessages([a.id, 'unknown']); check(['a', 'b', 'c']);
  prepare(); useStore.getState().updateMessage('unknown', { is_read: true }); check(['a', 'b', 'c']);
  prepare();
  useStore.getState().updateMessage(a.id, { message_count: 17 });
  useStore.getState().removeMessages([]);
  useStore.getState().restoreMessages([]);
  for (const params of [unified, ...scopes]) assert.ok(mailListCache.get(params, 1));
});


test('an account-scoped offscreen flag does not discard another account navigation snapshot', async () => {
  const { mailListCache } = await import('../utils/mailListCache.ts');
  seed();
  const scopes = [{ limit: 50 }, ...['a', 'b'].map(accountId => ({ limit: 50, accountId }))];
  const populate = () => scopes.forEach(params => mailListCache.finish(mailListCache.begin(params, 1), {
    messages: [{ id: 'cached', account_id: 'accountId' in params ? params.accountId : 'a' }], total: 1,
  }));
  populate();
  const beforeOffscreen = useStore.getState();
  useStore.getState().updateMessage('not-in-loaded-page', { is_read: true }, 'a');
  assert.equal(useStore.getState(), beforeOffscreen);
  assert.equal(mailListCache.get(scopes[0], 1), undefined);
  assert.equal(mailListCache.get(scopes[1], 1), undefined);
  assert.ok(mailListCache.get(scopes[2], 1));
  assert.equal(useStore.getState().messages[0].unread_count, 2);
  populate();
  // A known physical row takes precedence over a mismatched hint.
  useStore.getState().updateMessage('newest', { is_read: true }, 'b');
  assert.equal(mailListCache.get(scopes[1], 1), undefined);
  assert.ok(mailListCache.get(scopes[2], 1));
  for (const invalid of ['', ' a ']) {
    populate(); useStore.getState().updateMessage('not-loaded', { is_read: true }, invalid);
    assert.equal(mailListCache.get(scopes[2], 1), undefined);
  }
});

test('a physical read updates a singleton badge without requiring an expansion', () => {
  seed();
  useStore.setState({ messages: [{ id: 'only', account_id: 'a', thread_id: 'a:only', message_count: 1, unread_count: 1, is_read: false }], threadMessages: {} });
  useStore.getState().updateMessage('only', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 0);
  useStore.getState().updateMessage('only', { is_read: false });
  assert.equal(useStore.getState().messages[0].unread_count, 1);
});

test('reading a known child in an incomplete expansion preserves unobserved unread replies', () => {
  seed();
  useStore.setState({ messages: [{ id: 'newest', account_id: 'a', thread_id: 'a:thread', message_count: 3, unread_count: 3, is_read: false }] });
  useStore.getState().updateMessage('older', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 2);
  useStore.getState().updateMessage('newest', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 1);
  assert.equal(useStore.getState().messages[0].is_read, false);
});

test('list load, pagination and restoration preserve physical copies sharing RFC headers', () => {
  useStore.setState({ threadedView: false, threadMessages: {}, searchResults: [], searchQuery: '' });
  const rows = [{ id: 'read', account_id: 'a', message_id: '<same>', is_read: true }, { id: 'unread', account_id: 'a', message_id: '<same>', is_read: false }];
  useStore.getState().setMessages(rows);
  assert.deepEqual(useStore.getState().messages.map(row => row.id), ['read', 'unread']);
  useStore.getState().appendMessages([...rows, { ...rows[0], id: 'third' }]);
  assert.deepEqual(useStore.getState().messages.map(row => row.id), ['read', 'unread', 'third']);
  useStore.getState().removeMessage('unread');
  useStore.getState().restoreMessages([rows[1]]);
  assert.equal(useStore.getState().messages.some(row => row.id === 'unread'), true);
});

test('pending physical flags survive list, thread cache and account-scoped realtime refresh', async () => {
  const { queueReadStateMutation, resetReadStateMutationsForTest } = await import('../utils/readStateMutation.ts');
  resetReadStateMutationsForTest();
  seed();
  await queueReadStateMutation('older', true, async () => ({ pending: ['older'] })).promise;
  const children = [{ id: 'newest', account_id: 'a', folder: 'INBOX', is_read: false }, { id: 'older', account_id: 'a', folder: 'INBOX', is_read: false }];
  useStore.getState().setThreadMessages('a:thread', children);
  useStore.getState().setMessages([{ id: 'newest', account_id: 'a', folder: 'INBOX', thread_id: 'a:thread', message_count: 2, unread_count: 2, is_read: false }]);
  assert.equal(useStore.getState().messages[0].unread_count, 1);
  useStore.getState().updateMessage('older', { is_read: false }, 'a');
  assert.equal(useStore.getState().threadMessages['a:thread'][1].is_read, true);
  assert.equal(useStore.getState().messages[0].unread_count, 1);
  resetReadStateMutationsForTest();
});

test('pending unread and star survive search and restore snapshots', async () => {
  const { queueReadStateMutation, resetReadStateMutationsForTest } = await import('../utils/readStateMutation.ts');
  const { queueStarStateMutation } = await import('../utils/starStateMutation.ts');
  resetReadStateMutationsForTest();
  useStore.setState({ messages: [], searchResults: [], searchQuery: 'fixture', threadMessages: {} });
  await queueReadStateMutation('search-copy', false, async () => ({ pending: ['search-copy'] })).promise;
  await queueStarStateMutation('search-copy', true, async () => ({ pending: ['search-copy'] })).promise;
  const old = { id: 'search-copy', account_id: 'a', is_read: true, is_starred: false };
  useStore.getState().setSearchResults([old]);
  useStore.getState().restoreMessages([old]);
  for (const row of [useStore.getState().messages[0], useStore.getState().searchResults[0]]) {
    assert.equal(row.is_read, false);
    assert.equal(row.is_starred, true);
  }
  resetReadStateMutationsForTest();
});

test('a cached Sent child cannot alter an INBOX thread unread badge', () => {
  seed();
  useStore.setState({ messages: [{ id: 'newest', account_id: 'a', folder: 'INBOX', thread_id: 'a:thread', message_count: 2, unread_count: 1, is_read: false }],
    threadMessages: { 'a:thread': [{ id: 'newest', account_id: 'a', folder: 'INBOX', is_read: false }, { id: 'older', account_id: 'a', folder: 'Sent', is_read: true }] } });
  useStore.getState().updateMessage('older', { is_read: false });
  assert.equal(useStore.getState().messages[0].unread_count, 1);
  useStore.getState().updateMessage('newest', { is_read: true });
  assert.equal(useStore.getState().messages[0].unread_count, 0);
  assert.equal(useStore.getState().messages[0].is_read, true);
});

test('thread aggregate updates preserve the separate physical head flag', () => {
  seed();
  useStore.setState({ messages: [{ id: 'newest', account_id: 'a', thread_id: 'a:thread', message_count: 2, unread_count: 2, is_read: false, physical_is_read: false }] });
  useStore.getState().updateMessage('newest', { is_read: true });
  assert.equal(useStore.getState().messages[0].physical_is_read, true);
  assert.equal(useStore.getState().messages[0].is_read, false);
});

test('mixed thread aggregate never overwrites its successful physical head', () => {
  seed();
  useStore.setState({ messages: [{ id: 'newest', account_id: 'a', thread_id: 'a:thread', message_count: 2, unread_count: 0, is_read: true, physical_is_read: true }],
    threadMessages: { 'a:thread': [{ id: 'newest', account_id: 'a', is_read: true }, { id: 'older', account_id: 'a', is_read: false }] } });
  useStore.getState().updateMessage('newest', { is_read: false, unread_count: 1 });
  assert.equal(useStore.getState().messages[0].is_read, false);
  assert.equal(useStore.getState().messages[0].physical_is_read, true);
  assert.equal(useStore.getState().threadMessages['a:thread'][0].is_read, true);
});
