import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  return nextLoad(url, context);
} });
const storage = new Map<string, string>();
Reflect.set(globalThis, 'localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
});
const { api } = await import('./api.ts');
const { useStore } = await import('../store/index.ts');
const { openNotificationMessage } = await import('./notificationNavigation.ts');
const originalResolve = api.resolveMessage;
let refreshes = 0;
const row = (id: string, account_id = 'account-b') => ({ id, account_id, folder: 'Inbox/Alerts', subject: `Message ${id}` });

beforeEach(() => {
  storage.clear(); refreshes = 0;
  const browser = new EventTarget();
  browser.addEventListener('inboxora:refresh', () => { refreshes++; });
  Reflect.set(globalThis, 'window', browser);
  useStore.setState({ user: { id: 'owner' }, authEpoch: 12, isLocked: false,
    selectedAccountId: 'account-a', selectedFolder: 'INBOX', selectedMessageId: null,
    showAdmin: true, showCalendar: false, showContacts: false, showScheduled: false,
    searchQuery: 'old search', messages: [] });
});
afterEach(() => { api.resolveMessage = originalResolve; });

for (const module of ['showCalendar', 'showContacts', 'showScheduled'] as const) {
  test(`a notification leaves ${module} and opens its exact owned message and folder`, async () => {
    useStore.setState({ [module]: true });
    const requests: unknown[] = [];
    api.resolveMessage = async (id, accountId) => { requests.push([id, accountId]); return row(id); };
    await openNotificationMessage('physical-b', 'account-b', 12);
    const state = useStore.getState();
    assert.deepEqual(requests, [['physical-b', 'account-b']]);
    assert.equal(state.selectedAccountId, 'account-b');
    assert.equal(state.selectedFolder, 'Inbox/Alerts');
    assert.equal(state.selectedMessageId, 'physical-b');
    assert.equal(state.messages[0].id, 'physical-b');
    assert.equal(state.showAdmin, false);
    assert.equal(state.showCalendar || state.showContacts || state.showScheduled, false);
    assert.equal(state.searchQuery, '');
    assert.equal(refreshes, 1);
  });
}

test('a stale session, locked application or signed-out user cannot resolve a notification', async () => {
  let reads = 0;
  api.resolveMessage = async id => { reads++; return row(id); };
  await openNotificationMessage('stale', 'account-b', 11);
  useStore.setState({ isLocked: true });
  await openNotificationMessage('locked', 'account-b', 12);
  useStore.setState({ isLocked: false, user: null });
  await openNotificationMessage('signed-out', 'account-b', 12);
  assert.equal(reads, 0);
  assert.equal(refreshes, 0);
});

test('a session change while resolving discards the result without navigating', async () => {
  let release!: (value: ReturnType<typeof row>) => void;
  api.resolveMessage = () => new Promise(resolve => { release = resolve; });
  const opening = openNotificationMessage('late', 'account-b', 12);
  useStore.setState({ authEpoch: 13, user: { id: 'other-owner' } });
  release(row('late'));
  await opening;
  assert.equal(useStore.getState().selectedAccountId, 'account-a');
  assert.equal(useStore.getState().selectedMessageId, null);
  assert.deepEqual(useStore.getState().messages, []);
  assert.equal(refreshes, 0);
});

test('the last clicked notification wins when lookups finish out of order', async () => {
  const releases = new Map<string, (value: ReturnType<typeof row>) => void>();
  api.resolveMessage = id => new Promise(resolve => { releases.set(id, resolve); });
  const first = openNotificationMessage('first', 'account-b', 12);
  const second = openNotificationMessage('second', 'account-b', 12);
  releases.get('second')!(row('second')); await second;
  releases.get('first')!(row('first')); await first;
  assert.equal(useStore.getState().selectedMessageId, 'second');
  assert.deepEqual(useStore.getState().messages.map(message => message.id), ['second']);
  assert.equal(refreshes, 1);
});

test('a mismatched account or malformed resolved message never changes navigation', async () => {
  for (const response of [row('foreign', 'account-c'), {}, null]) {
    api.resolveMessage = async () => response;
    await openNotificationMessage('target', 'account-b', 12);
    assert.equal(useStore.getState().selectedAccountId, 'account-a');
    assert.equal(useStore.getState().selectedMessageId, null);
  }
  assert.equal(refreshes, 0);
});

test('an unavailable target propagates the error for the localized toast and leaves the view intact', async () => {
  api.resolveMessage = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  await assert.rejects(openNotificationMessage('gone', 'account-b', 12), /Not found/);
  assert.equal(useStore.getState().selectedAccountId, 'account-a');
  assert.equal(useStore.getState().showAdmin, true);
  assert.equal(refreshes, 0);
});

for (const [label, navigate] of [
  ['another account', () => useStore.getState().setSelectedAccount('account-c')],
  ['another folder', () => useStore.getState().setSelectedAccount('account-a', 'Archive')],
  ['same mailbox reload', () => useStore.getState().setSelectedAccount('account-a', 'INBOX')],
  ['another message', () => useStore.getState().setSelectedMessage('manual-choice')],
  ['contacts', () => useStore.getState().setShowContacts(true)],
  ['calendar', () => useStore.getState().setShowCalendar(true)],
  ['scheduled', () => useStore.getState().setShowScheduled(true)],
  ['another settings tab', () => useStore.getState().setAdminTab('calendar')],
  ['a new search', () => useStore.getState().setSearchQuery('manual search')],
  ['navigation away and back', () => { useStore.getState().setShowContacts(true); useStore.getState().setShowContacts(false); }],
] as const) {
  test(`manual navigation to ${label} wins over a pending notification`, async () => {
    let release!: (value: ReturnType<typeof row>) => void;
    api.resolveMessage = () => new Promise(resolve => { release = resolve; });
    const pending = openNotificationMessage('late', 'account-b', 12);
    navigate();
    const selected = useStore.getState().selectedMessageId;
    release(row('late')); await pending;
    assert.equal(useStore.getState().selectedMessageId, selected);
    assert.equal(useStore.getState().messages.some(message => message.id === 'late'), false);
    assert.equal(refreshes, 0);
  });
}

test('a rejected lookup after locking is silent', async () => {
  let reject!: (error: Error) => void;
  api.resolveMessage = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
  const pending = openNotificationMessage('late', 'account-b', 12);
  useStore.setState({ isLocked: true });
  reject(new Error('not found'));
  await assert.doesNotReject(pending);
  assert.equal(refreshes, 0);
});

test('an older rejected lookup cannot add an error after a later notification wins', async () => {
  let reject!: (error: Error) => void;
  api.resolveMessage = id => id === 'first'
    ? new Promise((_resolve, rejectPromise) => { reject = rejectPromise; })
    : Promise.resolve(row(id));
  const first = openNotificationMessage('first', 'account-b', 12);
  await openNotificationMessage('second', 'account-b', 12);
  reject(new Error('not found')); await assert.doesNotReject(first);
  assert.equal(useStore.getState().selectedMessageId, 'second');
  assert.equal(refreshes, 1);
});
