import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { queueReadStateMutation, isLatestReadStateMutation, pendingReadState, resetReadStateMutationsForTest, currentReadStateMutationVersion, readStateMutationRevision } from '../utils/readStateMutation.ts';
import { queueStarStateMutation, isLatestStarStateMutation, pendingStarState, resetStarStateMutationsForTest, currentStarStateMutationVersion, starStateMutationRevision } from '../utils/starStateMutation.ts';
import { mailMutationStatus, mailMutationFailure, mutationNotice } from '../utils/mailMutationOutcome.ts';
import { mailFlagReadbackTicket, projectMailFlagIntents, isInboxPhysicalMessage, scopedThreadUnreadCount } from '../utils/mailFlagIntents.ts';

// Execute the actual component callbacks with a small deterministic React/store
// boundary. No DOM or provider is involved, and the production queues stay real.
function callback<T>(file: string, name: string, context: Record<string, unknown>): T {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer, `Missing callback ${name}`);
  const compiled = ts.transpileModule(`const result = ${initializer.getText(source)}; result;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(compiled, { ...context, useCallback: (fn: unknown) => fn }) as T;
}
function deferred() {
  let resolve!: (response: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
function readerFixture(request: (id: string, value: boolean) => Promise<unknown>) {
  let current = true;
  const copies = [{ id: 'a', accountId: 'account', folder: 'INBOX', is_read: false, is_starred: false },
    { id: 'b', accountId: 'account', folder: 'INBOX', is_read: true, is_starred: true }];
  let data = { logicalMessages: copies.map(copy => ({ id: copy.id, copies: [copy] })) };
  const notices: Array<{ title: string; body: string }> = [];
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const refreshes: string[] = [];
  let unread = 1;
  const pending = new Map<string, string>();
  const state = { authEpoch: 0, isLocked: false, decrementUnread: () => { unread--; }, incrementUnread: () => { unread++; },
    adjustFolderUnread: () => {}, adjustCategoryCount: () => {}, addNotification: (notice: { title: string; body: string }) => notices.push(notice) };
  const context = {
    messages: data.logicalMessages, selectedAccountId: 'account', captureReaderScope: () => () => current,
    pendingReadState, pendingStarState, queueReadStateMutation, isLatestReadStateMutation,
    queueStarStateMutation, isLatestStarStateMutation, mailMutationStatus, mailMutationFailure, mutationNotice, isInboxPhysicalMessage,
    useStore: { getState: () => state }, setPending: (id: string, account: string) => pending.set(id, account), pendingMarkReadMap: pending,
    setLocalReadState: (id: string, value: boolean) => {
      updates.push({ id, fields: { is_read: value } });
      data = { logicalMessages: data.logicalMessages.map(message => ({ ...message, copies: message.copies.map(copy => copy.id === id ? { ...copy, is_read: value } : copy) })) };
    },
    setData: (update: (previous: typeof data) => typeof data) => { data = update(data); },
    updateMessage: (id: string, fields: Record<string, unknown>) => updates.push({ id, fields }),
    requestMailRefresh: (accountId: string) => refreshes.push(accountId),
    refreshEpoch: { current: 0 }, window: { dispatchEvent: () => {} }, CustomEvent: class {},
    api: { bulkRead: (ids: string[], value: boolean) => { calls.push(...ids); return request(ids[0], value); },
      markStarred: (id: string, value: boolean) => { calls.push(id); return request(id, value); } },
  };
  return {
    read: callback<(id: string, read: boolean) => Promise<void>>('./ConversationReader.tsx', 'setCopyReadState', context),
    star: callback<(id: string, starred: boolean) => Promise<void>>('./ConversationReader.tsx', 'setCopyStarredState', context),
    navigate: () => { current = false; }, logout: () => { current = false; state.authEpoch++; }, notices, updates, calls, pending, refreshes,
    unread: () => unread, data: () => data,
  };
}
beforeEach(() => { resetReadStateMutationsForTest(); resetStarStateMutationsForTest(); });

test('reader confirms ordinary success and marks only the selected physical copy', async () => {
  const fixture = readerFixture(async () => ({ ok: true }));
  await fixture.read('a', true);
  assert.deepEqual(fixture.calls, ['a']);
  assert.equal(fixture.data().logicalMessages[1].copies[0].is_read, true);
  assert.equal(fixture.unread(), 0);
  assert.equal(fixture.pending.size, 0);
  assert.equal(fixture.notices.length, 0);
});

test('reader retains unknown reads until authoritative readback, with no automatic retry', async () => {
  const fixture = readerFixture(async () => ({ ok: true, updated: [], pending: ['a'], failed: [] }));
  await fixture.read('a', true);
  assert.equal(pendingReadState('a'), true);
  assert.equal(fixture.pending.has('a'), true);
  assert.equal(fixture.notices[0].title, 'Mail change pending');
  assert.deepEqual(fixture.refreshes, ['account']);
  assert.deepEqual(fixture.calls, ['a']);
  const ticket = mailFlagReadbackTicket();
  assert.equal(projectMailFlagIntents([{ id: 'a', is_read: true }], ticket)[0].is_read, true);
  assert.equal(pendingReadState('a'), undefined);
});

test('reader permanent failed read restores the previous value and unread count', async () => {
  const fixture = readerFixture(async () => ({ ok: true, updated: [], pending: [], failed: ['a'] }));
  await fixture.read('a', true);
  assert.equal(fixture.data().logicalMessages[0].copies[0].is_read, false);
  assert.equal(fixture.unread(), 1);
  assert.equal(fixture.pending.size, 0);
  assert.equal(fixture.notices[0].title, 'Mail change failed');
});

test('reader unknown transport outcome stays pending instead of pretending failure', async () => {
  const fixture = readerFixture(async () => { throw new Error('connection closed after write'); });
  await fixture.read('a', true);
  assert.equal(fixture.data().logicalMessages[0].copies[0].is_read, true);
  assert.equal(pendingReadState('a'), true);
  assert.equal(fixture.notices[0].title, 'Mail change pending');
});

test('reader requests fresh provider evidence for an unknown star without retrying the write', async () => {
  const fixture = readerFixture(async () => { throw new Error('reply lost'); });
  await fixture.star('a', true);
  assert.deepEqual(fixture.calls, ['a']);
  assert.deepEqual(fixture.refreshes, ['account']);
  assert.equal(fixture.notices[0].title, 'Mail change pending');
  const ticket = mailFlagReadbackTicket();
  assert.equal(projectMailFlagIntents([{ id: 'a', is_starred: false }], ticket)[0].is_starred, false);
  assert.equal(pendingStarState('a'), undefined);
});

test('late failed read cannot roll back a newer unread intent', async () => {
  const first = deferred();
  let calls = 0;
  const fixture = readerFixture(async () => ++calls === 1 ? first.promise : { ok: true });
  const old = fixture.read('a', true);
  await Promise.resolve();
  const newest = fixture.read('a', false);
  first.resolve({ ok: true, failed: ['a'] });
  await Promise.all([old, newest]);
  assert.deepEqual(fixture.updates.map(update => update.fields.is_read), [true, false]);
  assert.equal(fixture.notices.length, 0);
  assert.equal(fixture.unread(), 1);
});

test('failed read after account navigation restores global state without updating the old reader', async () => {
  const response = deferred();
  const fixture = readerFixture(() => response.promise);
  const action = fixture.read('a', true);
  await Promise.resolve();
  fixture.navigate();
  response.resolve({ ok: true, failed: ['a'] });
  await action;
  assert.deepEqual(fixture.updates.map(update => update.fields.is_read), [true, false]);
  assert.equal(fixture.data().logicalMessages[0].copies[0].is_read, true, 'the previous reader stays untouched');
  assert.equal(fixture.unread(), 1);
  assert.equal(fixture.pending.size, 0);
  assert.equal(fixture.notices[0].title, 'Mail change failed');
  assert.deepEqual(fixture.refreshes, ['account']);
});

test('same-state star failure preserves an already-starred physical copy', async () => {
  const fixture = readerFixture(async () => ({ ok: true, failed: ['b'] }));
  await fixture.star('b', true);
  assert.equal(fixture.data().logicalMessages[1].copies[0].is_starred, true);
  assert.deepEqual(fixture.updates.map(update => update.fields.is_starred), [true, true]);
  assert.equal(fixture.notices[0].title, 'Mail change failed');
});

test('mixed read outcomes independently confirm and retain pending copies', async () => {
  const response = { ok: true, updated: ['b'], pending: ['a'], failed: ['c'] };
  const fixture = readerFixture(async () => response);
  await Promise.all([fixture.read('a', true), fixture.read('b', true)]);
  assert.equal(pendingReadState('a'), true);
  assert.equal(pendingReadState('b'), undefined);
  assert.equal(fixture.pending.has('a'), true);
  assert.equal(fixture.pending.has('b'), false);
  assert.equal(fixture.notices.length, 1);
});

test('bulk read resolves each selected conversation instead of writing representative IDs only', async () => {
  const targets: Array<{ id: string; read: boolean }> = [];
  const action = callback<(ids: string[], rows: Array<{ id: string; is_read: boolean; unread_count: number }>) => Promise<void>>('./MessageList.tsx', 'handleBulkMarkRead', {
    setSelectedIds: () => {}, setSelectionModeActive: () => {},
    setMessagesReadState: async (row: { id: string }, read: boolean) => targets.push({ id: row.id, read }),
  });
  await action(['thread-a', 'thread-b'], [{ id: 'thread-a', is_read: true, unread_count: 1 }, { id: 'thread-b', is_read: true, unread_count: 0 }]);
  assert.deepEqual(targets, [{ id: 'thread-a', read: true }, { id: 'thread-b', read: true }]);
});

import { queuePerCopyMutation, isLatestPerCopyMutation } from '../utils/perCopyMutation.ts';
import { beginMutation, isLatestMutation } from '../utils/mutationIntent.ts';
import { mergeThreadReadSnapshot } from '../utils/threadCacheState.ts';
import { normalizedNativeThreadMembers, nativeThreadCacheMatchesRow } from '../utils/nativeThreadMembership.ts';
import type { StoreMessageRow } from '../store/index.ts';

function listFixture(request: (id: string) => Promise<unknown>, membershipGate: Promise<unknown> = Promise.resolve()) {
  const children: StoreMessageRow[] = [
    { id: 'a', account_id: 'account', thread_id: 'thread', folder: 'INBOX', is_read: false, is_starred: true },
    { id: 'b', account_id: 'account', thread_id: 'thread', folder: 'INBOX', is_read: false, is_starred: false },
    { id: 'c', account_id: 'account', thread_id: 'thread', folder: 'INBOX', is_read: true, is_starred: true },
    { id: 'd', account_id: 'account', thread_id: 'thread', folder: 'INBOX', is_read: false, is_starred: false },
  ];
  const row = { ...children[0], message_count: 4, unread_count: 3 };
  const state = { authEpoch: 0, isLocked: false, loadingThread: null, adjustFolderUnread: () => {},
    messages: [row], threadMessages: { thread: children } as Record<string, StoreMessageRow[]> };
  let unread = 3;
  const notices: Array<{ title: string }> = [];
  const categoryChanges: Array<[string | null | undefined, number]> = [];
  const pending = new Map<string, string>();
  const completed = new Map<string, string>();
  const context = {
    useStore: { getState: () => state }, isThreadListRow: () => true,
    resolveMessagesForThreadAction: async () => { await membershipGate; return children; },
    captureThreadScope: () => () => true, threadLoadLifetimeRef: { current: 0 },
    threadListGenerationRef: { current: 0 }, threadLoadVersionsRef: { current: new Map() },
    refreshRequest: { isPending: () => false, invalidate: () => {} },
    queuePerCopyMutation, isLatestPerCopyMutation, queueReadStateMutation, isLatestReadStateMutation, pendingReadState, currentReadStateMutationVersion, readStateMutationRevision,
    queueStarStateMutation, isLatestStarStateMutation, pendingStarState, currentStarStateMutationVersion, starStateMutationRevision, beginMutation, isLatestMutation,
    mailMutationStatus, mailMutationFailure, mutationNotice, mergeThreadReadSnapshot, isInboxPhysicalMessage, scopedThreadUnreadCount,
    normalizedNativeThreadMembers, nativeThreadCacheMatchesRow,
    updateMessage: (id: string, fields: Record<string, unknown>) => {
      state.messages = state.messages.map(message => message.id === id ? { ...message, ...fields } : message);
    },
    decrementUnread: (_account: string, count: number) => { unread -= count; },
    incrementUnread: (_account: string, count: number) => { unread += count; },
    adjustCategoryCount: (category: string | null | undefined, delta: number) => categoryChanges.push([category, delta]), setLoadingThread: () => {}, invalidateThreadLoad: () => {},
    setThreadMessages: (id: string, messages: StoreMessageRow[]) => { state.threadMessages[id] = messages; },
    setCachedThreadStates: (_row: unknown, field: string, states: Map<string, boolean>) => {
      state.threadMessages.thread = state.threadMessages.thread.map(message => states.has(message.id) ? { ...message, [field]: states.get(message.id) } : message);
    },
    setPending: (id: string, account: string) => pending.set(id, account), pendingMarkReadMap: pending, completedMarkReadMap: completed,
    setTimeout: () => {}, requestMailRefresh: () => {},
    addNotification: (notice: { title: string }) => notices.push(notice),
    window: { dispatchEvent: () => {} }, CustomEvent: class {}, Event: class {},
    sendMailRead: (id: string) => request(id),
    api: { bulkRead: (ids: string[]) => request(ids[0]), markStarred: (id: string) => request(id) },
    console, toAppError: (error: Error) => error,
  };
  return { row, state, notices, pending, completed, categoryChanges, unread: () => unread,
    read: callback<(row: StoreMessageRow, read: boolean) => Promise<void>>('./MessageList.tsx', 'setMessagesReadState', context),
    star: callback<(row: StoreMessageRow, star: boolean) => Promise<void>>('./MessageList.tsx', 'setMessagesStarredState', context),
  };
}

test('whole-thread read handles confirmed, pending and failed physical copies independently', async () => {
  const fixture = listFixture(async () => ({ ok: true, updated: ['a'], pending: ['b'], failed: ['c', 'd'] }));
  await fixture.read(fixture.row, true);
  assert.deepEqual(Array.from(fixture.state.threadMessages.thread, copy => copy.is_read), [true, true, true, false]);
  assert.deepEqual([...fixture.completed.keys()], ['a']);
  assert.deepEqual([...fixture.pending.keys()], ['b']);
  assert.equal(fixture.state.messages[0].unread_count, 1);
  assert.equal(fixture.unread(), 1);
  assert.deepEqual(fixture.notices.map(notice => notice.title), ['Mail change failed', 'Mail change pending']);
});

test('whole-thread star restores exact per-copy state on mixed permanent failures', async () => {
  const fixture = listFixture(async () => ({ ok: true, updated: ['d'], failed: ['a', 'b', 'c'], pending: [] }));
  await fixture.star(fixture.row, true);
  assert.deepEqual(fixture.state.threadMessages.thread.map(copy => copy.is_starred), [true, false, true, true]);
  assert.equal(fixture.state.messages[0].is_starred, true);
  assert.equal(fixture.notices[0].title, 'Mail change failed');
});


test('delayed opening cannot override an explicit read intent that already confirmed', async () => {
  let fire: (() => void) | undefined;
  const calls: string[] = [];
  const open = callback<(row: { id: string; is_read: boolean }) => void>('./MessageList.tsx', 'markMessageReadOnOpen', {
    autoMarkReadTimerRef: { current: undefined }, clearTimeout: () => {}, useStore: { getState: () => ({ threadMessages: {} }) },
    setTimeout: (work: () => void) => { fire = work; }, markReadBehavior: 'delay', markReadDelay: 1,
    captureThreadScope: () => () => true, pendingReadState, currentReadStateMutationVersion,
    setMessagesReadState: async (row: { id: string }) => { calls.push(row.id); },
  });
  open({ id: 'a', is_read: false });
  await queueReadStateMutation('a', false, async () => ({ ok: true })).promise;
  assert.equal(pendingReadState('a'), undefined);
  assert.ok(fire);
  fire();
  assert.deepEqual(calls, []);
});

test('a child intent made during whole-thread resolution takes precedence', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const fixture = listFixture(async id => { calls.push(id); return { ok: true }; }, gate.promise);
  const wholeThread = fixture.read(fixture.row, true);
  await queueReadStateMutation('b', false, async () => ({ ok: true })).promise;
  gate.resolve(undefined);
  await wholeThread;
  assert.deepEqual(calls, ['a', 'c', 'd']);
  assert.equal(fixture.state.threadMessages.thread.find(copy => copy.id === 'b')?.is_read, false);
  assert.equal(fixture.state.messages[0].unread_count, 1);
});


test('a child star intent made during whole-thread resolution takes precedence', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const fixture = listFixture(async id => { calls.push(id); return { ok: true }; }, gate.promise);
  const wholeThread = fixture.star(fixture.row, true);
  await queueStarStateMutation('b', false, async () => ({ ok: true })).promise;
  gate.resolve(undefined);
  await wholeThread;
  assert.deepEqual(calls, ['a', 'c', 'd']);
  assert.equal(fixture.state.threadMessages.thread.find(copy => copy.id === 'b')?.is_starred, false);
});


test('thread read badges count INBOX membership and each child category, excluding Sent and Archive', async () => {
  const fixture = listFixture(async () => ({ ok: true, updated: ['a', 'b', 'c'], failed: ['d'] }));
  Object.assign(fixture.row, { _mailProjectionScope: { folder: 'INBOX', category: 'primary' } });
  const [inbox, sent, archived, labeledInbox] = fixture.state.threadMessages.thread;
  Object.assign(inbox, { category: 'primary' });
  Object.assign(sent, { folder: 'Sent', category: 'promotion' });
  Object.assign(archived, { folder: 'INBOX', is_archived: true, is_read: false, category: 'primary' });
  Object.assign(labeledInbox, { folder: '[Gmail]/All Mail', folder_paths: ['INBOX', '[Gmail]/All Mail'], category: 'promotion' });
  await fixture.read(fixture.row, true);
  assert.equal(fixture.unread(), 2, 'only the successfully changed inbox copy decrements the account badge');
  assert.equal(fixture.state.messages[0].unread_count, 0, 'the failed promotion copy is outside the primary list category');
  assert.deepEqual(fixture.categoryChanges, [['primary', -1], ['promotion', -1], ['promotion', 1]]);
  assert.equal(fixture.state.threadMessages.thread.find(copy => copy.id === 'b')?.is_read, true);
  assert.equal(fixture.state.threadMessages.thread.find(copy => copy.id === 'c')?.is_read, true);
});


test('opening an aggregate-unread thread head uses its physical read flag', () => {
  const calls: StoreMessageRow[] = [];
  const state = { threadMessages: {} as Record<string, StoreMessageRow[]> };
  const open = callback<(row: StoreMessageRow) => void>('./MessageList.tsx', 'markMessageReadOnOpen', {
    autoMarkReadTimerRef: { current: undefined }, clearTimeout: () => {}, markReadBehavior: 'instant', markReadDelay: 1,
    useStore: { getState: () => state }, captureThreadScope: () => () => true, pendingReadState, currentReadStateMutationVersion,
    setMessagesReadState: async (row: StoreMessageRow) => { calls.push(row); },
  });
  const row: StoreMessageRow = { id: 'head', account_id: 'account', thread_id: 'thread', is_read: false, physical_is_read: true, unread_count: 1 };
  open(row);
  assert.equal(calls.length, 0, 'an unread sibling does not make the physically read head unread');
  state.threadMessages.thread = [{ id: 'head', account_id: 'account', is_read: true }];
  open({ ...row, physical_is_read: false });
  assert.equal(calls.length, 0, 'an exact cached physical flag takes precedence');
  state.threadMessages.thread = [{ id: 'head', account_id: 'account', is_read: false }];
  open({ ...row, is_read: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'head');
  assert.equal(calls[0].is_read, false);
  assert.equal(calls[0]._normalizedSingleton, true);
});


test('failed star after account navigation restores global state without updating the old reader', async () => {
  const response = deferred();
  const fixture = readerFixture(() => response.promise);
  const action = fixture.star('a', true);
  await Promise.resolve();
  fixture.navigate();
  response.resolve({ ok: true, failed: ['a'] });
  await action;
  assert.deepEqual(fixture.updates.map(update => update.fields.is_starred), [true, false]);
  assert.equal(fixture.data().logicalMessages[0].copies[0].is_starred, true, 'the previous reader stays untouched');
  assert.deepEqual(fixture.refreshes, ['account']);
});

test('failed read and star after logout cannot change a later session', async () => {
  const response = deferred();
  const fixture = readerFixture(() => response.promise);
  const read = fixture.read('a', true);
  const star = fixture.star('a', true);
  await Promise.resolve();
  fixture.logout();
  response.resolve({ ok: true, failed: ['a'] });
  await Promise.all([read, star]);
  assert.equal(fixture.updates.length, 2, 'only the initial optimistic updates ran');
  assert.equal(fixture.notices.length, 0);
  assert.deepEqual(fixture.refreshes, []);
});
