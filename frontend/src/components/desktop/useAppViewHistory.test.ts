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
const { accountScope, createAppViewHistory } = await import('./useAppViewHistory.tsx');
const { viewSnapshotFromState } = await import('../../utils/viewHistory.ts');
type StoreMessageRow = import('../../store/index.ts').StoreMessageRow;

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** A promise the test resolves by hand, to control when a lookup lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function row(id: string, folder = 'INBOX', messageId: string | null = null): StoreMessageRow {
  return { id, account_id: 'a1', folder, message_id: messageId, subject: `subject ${id}` };
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
 * change, using the real store actions. The echo after a restore has to be
 * replayed explicitly, because it is what consumes the restore marker before a
 * late lookup lands.
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
  record(); // the recorder echo for the restored view

  const restored = viewSnapshotFromState(useStore.getState());
  assert.equal(restored.folder, 'INBOX');
  assert.equal(restored.messageId, 'm1');
  assert.equal(useStore.getState().selectedFolder, 'INBOX');

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
  record(); // the recorder echo, which consumes the restore marker
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
  record(); // the recorder echo, which consumes the restore marker
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
  record(); // the recorder echo, which consumes the restore marker
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
  record(); // the recorder echo, which consumes the restore marker
  // The user opens something else before the lookup lands.
  useStore.getState().setSelectedMessage(null);
  lookup.resolve(row('m1'));
  await tick();

  assert.deepEqual(Object.values(useStore.getState().threadMessages).flat(), []);
});

test('a message that came back with a new row id keeps Forward available', async () => {
  resetStore();
  const calls: Array<{ ref: string; accountId?: string }> = [];
  const history = createAppViewHistory({
    resolveMessage: async (ref, accountId) => {
      calls.push({ ref, accountId });
      // Moved and re-created: same RFC Message-ID, brand-new physical row id.
      return ref === '<stable@message.id>' ? row('new-uuid', 'Sent', '<stable@message.id>') : null;
    },
  });
  const record = recorder(history);

  history.reset();
  useStore.setState({
    messages: [row('old-uuid', 'INBOX', '<stable@message.id>')],
    selectedMessageId: 'old-uuid',
  });
  record();

  useStore.getState().setSelectedAccount(null, 'Sent');
  record(); // the INBOX page (and its row) is gone from here on

  history.navigate('back');
  record(); // the recorder echo, which consumes the restore marker
  await tick();

  // The exact row is tried first (and only it — see the next test). Once it is gone,
  // the durable Message-ID takes over, scoped to the account the message belongs to.
  assert.deepEqual(calls, [
    { ref: 'old-uuid', accountId: undefined },
    { ref: '<stable@message.id>', accountId: 'a1' },
  ]);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'new-uuid');
  assert.deepEqual(Object.values(state.threadMessages).flat().map((message) => message.id), ['new-uuid']);

  // Selecting the new physical row is still the same history step, so the echo it
  // produces must not add an entry and strand Forward.
  record();
  assert.deepEqual(history.getState(), { canGoBack: true, canGoForward: true });
  assert.equal(Object.values(useStore.getState().threadMessages).flat().length, 1);

  history.navigate('forward');
  assert.equal(useStore.getState().selectedFolder, 'Sent');
});

test('the exact copy wins over the durable reference for the same message', async () => {
  resetStore();
  const calls: Array<{ ref: string; accountId?: string }> = [];
  const history = createAppViewHistory({
    resolveMessage: async (ref, accountId) => {
      calls.push({ ref, accountId });
      // The Archive copy the user was reading still exists. The same Message-ID also
      // lives in INBOX, which /resolve-message prefers when asked by Message-ID.
      if (ref === 'archive-uuid') return row('archive-uuid', 'Archive', '<same@id>');
      if (ref === '<same@id>') return row('inbox-uuid', 'INBOX', '<same@id>');
      return null;
    },
  });
  const record = recorder(history);

  history.reset();
  useStore.setState({
    messages: [row('archive-uuid', 'Archive', '<same@id>')],
    selectedMessageId: 'archive-uuid',
    selectedFolder: 'Archive',
  });
  record();

  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  record(); // the recorder echo
  await tick();

  // Only the exact row was asked for, so the copy the user was reading comes back
  // instead of the INBOX twin the durable lookup would have preferred.
  assert.deepEqual(calls, [{ ref: 'archive-uuid', accountId: undefined }]);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'archive-uuid');
  assert.equal(state.selectedFolder, 'Archive');
  assert.deepEqual(Object.values(state.threadMessages).flat().map((message) => message.folder), ['Archive']);

  record();
  assert.deepEqual(history.getState(), { canGoBack: true, canGoForward: true });
});

test('the message reference is scoped like the backend expects', () => {
  // /mail/resolve-message rejects a non-UUID accountId with 400, so an unusable
  // scope must be dropped rather than sent and break the durable lookup.
  assert.equal(accountScope('11111111-2222-3333-4444-555555555555'), '11111111-2222-3333-4444-555555555555');
  assert.equal(accountScope('not-a-uuid'), undefined);
  assert.equal(accountScope(''), undefined);
  assert.equal(accountScope(null), undefined);
  assert.equal(accountScope(undefined), undefined);
});
