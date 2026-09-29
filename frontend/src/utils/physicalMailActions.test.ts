import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { StoreMessageRow, StoreState } from '../store/index.ts';
import { createPhysicalMailActions } from './physicalMailActions.ts';
import { getAuthEpoch, setAuthEpoch } from './authEpoch.ts';
import { completedMarkReadMap, pendingMarkReadMap } from './pendingReads.ts';
import { projectMailFlagIntents, mailFlagReadbackTicket } from './mailFlagIntents.ts';

beforeEach(() => setAuthEpoch(getAuthEpoch() + 1));
afterEach(() => setAuthEpoch(getAuthEpoch() + 1));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: Partial<StoreMessageRow> = {}) {
  const message: StoreMessageRow = { id: 'copy', account_id: 'account', folder: 'INBOX', is_read: false, is_starred: false, ...initial };
  const row = { ...message };
  let unread = 1;
  let category = 1;
  const folders = new Map<string, number>([['INBOX', 1], ['Work', 1], ['Sent', 1]]);
  const notices: Array<Parameters<StoreState['addNotification']>[0]> = [];
  const refreshed: string[] = [];
  const updates: unknown[] = [];
  const state = {
    authEpoch: getAuthEpoch(), isLocked: false, selectedAccountId: 'account', selectedFolder: 'INBOX',
    updateMessage(id: string, values: Record<string, unknown>, accountId?: string | null) {
      assert.equal(id, row.id); assert.equal(accountId, row.account_id);
      Object.assign(row, values); updates.push(values);
    },
    decrementUnread(_accountId: string, count = 1) { unread -= count; },
    incrementUnread(_accountId: string, count = 1) { unread += count; },
    adjustCategoryCount(_category: string | null | undefined, delta: number) { category += delta; },
    adjustFolderUnread(_accountId: string, folder: string | undefined, delta: number) {
      if (folder) folders.set(folder, (folders.get(folder) ?? 0) + delta);
    },
    addNotification(value: Parameters<StoreState['addNotification']>[0]) { notices.push(value); },
  };
  return { message, row, state, notices, refreshed, updates, folders,
    counts: () => ({ unread, category }),
    ports: { getState: () => state, refresh: (accountId: string) => { refreshed.push(accountId); } },
  };
}

test('a pending read is not marked confirmed and opposite readback releases optimism', async () => {
  const f = fixture({ folder_paths: ['INBOX', 'Work'] });
  const actions = createPhysicalMailActions({ ...f.ports, read: async () => ({ ok: true, pending: ['copy'], updated: [] }) });
  assert.equal(await actions.read(f.message, true), 'pending');
  assert.equal(f.row.is_read, true);
  assert.equal(pendingMarkReadMap.has('copy'), true);
  assert.equal(completedMarkReadMap.has('copy'), false);
  assert.deepEqual(f.counts(), { unread: 0, category: 0 });
  assert.equal(f.folders.get('INBOX'), 0);
  assert.equal(f.folders.get('Work'), 0);
  assert.deepEqual(f.refreshed, ['account']);
  assert.equal(f.notices.length, 1);
  const readback = projectMailFlagIntents([{ id: 'copy', is_read: false }], mailFlagReadbackTicket());
  assert.equal(readback[0].is_read, false);
  assert.equal(pendingMarkReadMap.has('copy'), false);
  assert.equal(completedMarkReadMap.has('copy'), false);
});

test('a per-item permanent refusal restores exact state and affected counts', async () => {
  const f = fixture();
  const actions = createPhysicalMailActions({ ...f.ports, read: async () => ({ ok: true, outcomes: [{ id: 'copy', status: 'permanent' }] }) });
  assert.equal(await actions.read(f.message, true), 'failed');
  assert.equal(f.row.is_read, false);
  assert.deepEqual(f.counts(), { unread: 1, category: 1 });
  assert.equal(f.folders.get('INBOX'), 1);
  assert.equal(completedMarkReadMap.has('copy'), false);
  assert.equal(f.notices.length, 1);
});

test('a network-uncertain read never blindly retries', async () => {
  const f = fixture(); let calls = 0;
  const actions = createPhysicalMailActions({ ...f.ports, read: async () => { calls++; throw new TypeError('Synthetic network uncertainty'); } });
  assert.equal(await actions.read(f.message, true), 'pending');
  assert.equal(calls, 1);
  assert.equal(completedMarkReadMap.has('copy'), false);
  assert.deepEqual(f.refreshed, ['account']);
});

test('an explicit same-state action still reaches the provider', async () => {
  const f = fixture(); let calls = 0;
  const actions = createPhysicalMailActions({ ...f.ports, read: async (_id, read) => { calls++; assert.equal(read, false); return { updated: ['copy'] }; } });
  assert.equal(await actions.read(f.message, false), 'confirmed');
  assert.equal(calls, 1);
  assert.deepEqual(f.counts(), { unread: 1, category: 1 });
});

test('a Sent copy does not change Inbox or category badges', async () => {
  const f = fixture({ folder: 'Sent' });
  const actions = createPhysicalMailActions({ ...f.ports, read: async () => ({ updated: ['copy'] }) });
  assert.equal(await actions.read(f.message, true), 'confirmed');
  assert.deepEqual(f.counts(), { unread: 1, category: 1 });
  assert.equal(f.folders.get('Sent'), 0);
  assert.equal(f.folders.get('INBOX'), 1);
  assert.equal(completedMarkReadMap.has('copy'), false);
});

test('a late refusal cannot mutate a replacement session', async () => {
  const f = fixture();
  const response = deferred<unknown>();
  const actions = createPhysicalMailActions({ ...f.ports, read: () => response.promise });
  const work = actions.read(f.message, true);
  await Promise.resolve(); await Promise.resolve();
  setAuthEpoch(getAuthEpoch() + 1);
  f.state.authEpoch = getAuthEpoch();
  f.updates.length = 0;
  response.resolve({ failed: ['copy'] });
  await work;
  assert.equal(f.updates.length, 0);
  assert.equal(f.notices.length, 0);
  assert.equal(f.refreshed.length, 0);
});

test('an older failed star response cannot erase the newest of three intents', async () => {
  const f = fixture();
  const first = deferred<unknown>();
  const third = deferred<unknown>();
  let calls = 0;
  const actions = createPhysicalMailActions({ ...f.ports, star: () => {
    calls++;
    return calls === 1 ? first.promise : calls === 3 ? third.promise : Promise.resolve({ updated: ['copy'] });
  } });
  const one = actions.star(f.message, true);
  const two = actions.star(f.message, false);
  const three = actions.star(f.message, true);
  assert.equal(f.row.is_starred, true);
  first.resolve({ failed: ['copy'] });
  await one; await two;
  assert.equal(f.row.is_starred, true);
  assert.equal(f.notices.length, 0);
  third.resolve({ updated: ['copy'] });
  assert.equal(await three, 'confirmed');
  assert.equal(calls, 3);
  assert.equal(f.row.is_starred, true);
});
