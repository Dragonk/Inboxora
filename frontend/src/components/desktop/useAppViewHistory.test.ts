import test from 'node:test';
import assert from 'node:assert/strict';

// The store reads localStorage while the module is being created, so the stub has
// to exist before it is imported.
const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
};

const { useStore } = await import('../../store/index.ts');
const { createAppViewHistory } = await import('./useAppViewHistory.tsx');
const { viewSnapshotFromState } = await import('../../utils/viewHistory.ts');
type StoreMessageRow = import('../../store/index.ts').StoreMessageRow;

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** A promise the test resolves by hand, to control when a lookup lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function row(id: string, folder = 'INBOX'): StoreMessageRow {
  return { id, account_id: 'a1', folder, subject: `subject ${id}` };
}

/** The view fields the history tracks, back to a known baseline. */
function resetStore(overrides: Record<string, unknown> = {}): void {
  useStore.setState({
    showContacts: false,
    showCalendar: false,
    showAdmin: false,
    adminTab: 'accounts',
    selectedAccountId: null,
    selectedFolder: 'INBOX',
    selectedMessageId: null,
    messages: [],
    searchResults: [],
    threadMessages: {},
    ...overrides,
  });
}

/**
 * Drives the history exactly like AppViewHistoryRecorder: one record() per view
 * change, using the real store actions.
 */
function recorder(history: { record(): void }) {
  return () => history.record();
}

test('Back restores a message whose folder page setSelectedAccount() just cleared', () => {
  resetStore();
  const history = createAppViewHistory({ resolveMessage: async () => null });
  const record = recorder(history);

  history.reset();
  assert.equal(viewSnapshotFromState(useStore.getState()).folder, 'INBOX');

  // Open m1 in INBOX.
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();

  // Navigate to Sent. The real setter clears messages, threadMessages and the
  // open message — the first version gated the restore on those arrays and lost m1.
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();
  assert.deepEqual(
    { folder: viewSnapshotFromState(useStore.getState()).folder, message: useStore.getState().messages.length },
    { folder: 'Sent', message: 0 },
  );

  history.navigate('back');

  const restored = viewSnapshotFromState(useStore.getState());
  assert.equal(restored.folder, 'INBOX');
  assert.equal(restored.messageId, 'm1');
  assert.equal(useStore.getState().selectedFolder, 'INBOX');

  // The recorder echo must not strand Forward.
  record();
  assert.deepEqual(history.getState(), { canGoBack: true, canGoForward: true });
});

test('a restored message that is not on the loaded page is fetched for the reader', async () => {
  resetStore();
  const fetched: string[] = [];
  const history = createAppViewHistory({
    resolveMessage: async (id) => { fetched.push(id); return id === 'm1' ? row('m1') : null; },
  });
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  await tick();

  assert.deepEqual(fetched, ['m1']);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'm1');
  // Parked where setMessages() cannot evict it, so MessagePane can resolve it.
  assert.deepEqual(Object.values(state.threadMessages).flat().map((message) => message.id), ['m1']);
});

test('an already loaded message is restored without a request', async () => {
  resetStore();
  const fetched: string[] = [];
  const history = createAppViewHistory({
    resolveMessage: async (id) => { fetched.push(id); return row(id); },
  });
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();
  // Same folder: leave the reader, then come back with the page still loaded.
  useStore.setState({ selectedMessageId: null });
  record();

  history.navigate('back');
  await tick();

  assert.deepEqual(fetched, []);
  assert.equal(useStore.getState().selectedMessageId, 'm1');
});

test('a message resolved for a previous session is never injected', async () => {
  resetStore();
  const lookup = deferred<StoreMessageRow | null>();
  const history = createAppViewHistory({ resolveMessage: () => lookup.promise });
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  // The session ends while the lookup is in flight.
  useStore.setState({ authEpoch: useStore.getState().authEpoch + 1 });
  lookup.resolve(row('m1'));
  await tick();

  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'm1');
  assert.deepEqual(Object.values(state.threadMessages).flat(), []);
});

test('a lookup that finishes after the user navigated on is dropped', async () => {
  resetStore();
  const lookup = deferred<StoreMessageRow | null>();
  const history = createAppViewHistory({ resolveMessage: () => lookup.promise });
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  // The user opens something else before the lookup lands.
  useStore.getState().setSelectedMessage(null);
  lookup.resolve(row('m1'));
  await tick();

  assert.deepEqual(Object.values(useStore.getState().threadMessages).flat(), []);
});
