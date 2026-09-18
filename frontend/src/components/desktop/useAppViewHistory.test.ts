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

/** A 404 like api.request() throws when /mail/messages/:id has no such row. */
function notFound(): Error {
  const error = new Error('Message not found') as Error & { status?: number };
  error.status = 404;
  return error;
}

/**
 * The seams are the *raw* calls, so the production code that decides "404 means the
 * row is gone, anything else is a failure" is exercised rather than stubbed out.
 * `exact` returning null therefore rejects with a real 404, exactly like api.request().
 */
function lookups({ exact, durable }: {
  exact: (id: string) => StoreMessageRow | null | Promise<StoreMessageRow | null>;
  durable: (ref: string, accountId?: string) => StoreMessageRow | null | Promise<StoreMessageRow | null>;
}) {
  const exactCalls: string[] = [];
  const durableCalls: Array<{ ref: string; accountId?: string }> = [];
  const options = {
    lookupMessage: async (id: string) => {
      exactCalls.push(id);
      const found = await exact(id);
      if (found) return found;
      throw notFound();
    },
    resolveMessage: async (ref: string, accountId?: string) => {
      durableCalls.push({ ref, accountId });
      return durable(ref, accountId);
    },
  };
  return { options, exactCalls, durableCalls };
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
  const { options } = lookups({ exact: () => null, durable: () => null });
  const history = createAppViewHistory(options);
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
  const { options, exactCalls, durableCalls } = lookups({
    exact: (id) => (id === 'm1' ? row('m1') : null),
    durable: () => null,
  });
  const history = createAppViewHistory(options);
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('m1')], selectedMessageId: 'm1' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  record(); // the recorder echo, which consumes the restore marker
  await tick();

  assert.deepEqual(exactCalls, ['m1']);
  assert.deepEqual(durableCalls, []);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'm1');
  // Parked where setMessages() cannot evict it, so MessagePane can resolve it.
  assert.deepEqual(Object.values(state.threadMessages).flat().map((message) => message.id), ['m1']);
});

test('an already loaded message is restored without a request', async () => {
  resetStore();
  const { options, exactCalls, durableCalls } = lookups({
    exact: (id) => row(id),
    durable: (ref) => row(ref),
  });
  const history = createAppViewHistory(options);
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

  assert.deepEqual(exactCalls, []);
  assert.deepEqual(durableCalls, []);
  assert.equal(useStore.getState().selectedMessageId, 'm1');
});

test('a message resolved for a previous session is never injected', async () => {
  resetStore();
  // The exact row is really gone (404), so the durable lookup is the one left in
  // flight — and both seams are stubbed, so nothing reaches the real API and the
  // assertions below cannot pass because a request failed early.
  const lookup = deferred<StoreMessageRow | null>();
  const { options, exactCalls, durableCalls } = lookups({ exact: () => null, durable: () => lookup.promise });
  const history = createAppViewHistory(options);
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('old-uuid', 'INBOX', '<stable@message.id>')], selectedMessageId: 'old-uuid' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  record(); // the recorder echo, which consumes the restore marker
  // The session ends while the durable lookup is in flight.
  useStore.setState({ authEpoch: useStore.getState().authEpoch + 1 });
  lookup.resolve(row('new-uuid', 'INBOX', '<stable@message.id>'));
  await tick();

  assert.deepEqual(exactCalls, ['old-uuid']);
  assert.deepEqual(durableCalls, [{ ref: '<stable@message.id>', accountId: 'a1' }]);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'old-uuid');
  assert.deepEqual(Object.values(state.threadMessages).flat(), []);
});

test('a lookup that finishes after the user navigated on is dropped', async () => {
  resetStore();
  const lookup = deferred<StoreMessageRow | null>();
  const { options, exactCalls, durableCalls } = lookups({ exact: () => null, durable: () => lookup.promise });
  const history = createAppViewHistory(options);
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('old-uuid', 'INBOX', '<stable@message.id>')], selectedMessageId: 'old-uuid' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  record(); // the recorder echo, which consumes the restore marker
  // The user opens something else before the durable lookup lands.
  useStore.getState().setSelectedMessage(null);
  lookup.resolve(row('new-uuid', 'INBOX', '<stable@message.id>'));
  await tick();

  assert.deepEqual(exactCalls, ['old-uuid']);
  assert.deepEqual(durableCalls, [{ ref: '<stable@message.id>', accountId: 'a1' }]);
  assert.deepEqual(Object.values(useStore.getState().threadMessages).flat(), []);
});

test('a 404 on the exact row falls back to the durable reference and keeps Forward available', async () => {
  resetStore();
  // The move re-created the row, so the exact id is really gone: the API answers 404
  // (which api.getMessage() turns into null), and only then is the Message-ID asked for.
  const { options, exactCalls, durableCalls } = lookups({
    exact: () => null,
    durable: (ref) => (ref === '<stable@message.id>' ? row('new-uuid', 'Sent', '<stable@message.id>') : null),
  });
  const history = createAppViewHistory(options);
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

  // The gone row was asked for by its exact id, then the durable Message-ID took
  // over, scoped to the account the message belongs to.
  assert.deepEqual(exactCalls, ['old-uuid']);
  assert.deepEqual(durableCalls, [{ ref: '<stable@message.id>', accountId: 'a1' }]);
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
  // The Archive copy the user was reading still exists. The same Message-ID also
  // lives in INBOX, which /resolve-message prefers when asked by Message-ID.
  const { options, exactCalls, durableCalls } = lookups({
    exact: () => row('archive-uuid', 'Archive', '<same@id>'),
    durable: () => row('inbox-uuid', 'INBOX', '<same@id>'),
  });
  const history = createAppViewHistory(options);
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
  assert.deepEqual(exactCalls, ['archive-uuid']);
  assert.deepEqual(durableCalls, []);
  const state = useStore.getState();
  assert.equal(state.selectedMessageId, 'archive-uuid');
  assert.equal(state.selectedFolder, 'Archive');
  assert.deepEqual(Object.values(state.threadMessages).flat().map((message) => message.folder), ['Archive']);

  record();
  assert.deepEqual(history.getState(), { canGoBack: true, canGoForward: true });
});

test('a transient lookup failure does not fall back to another copy', async () => {
  resetStore();
  const durableRefs: string[] = [];
  const history = createAppViewHistory({
    lookupMessage: async () => {
      const error = new Error('Failed to load message') as Error & { status?: number };
      error.status = 500;
      throw error;
    },
    resolveMessage: async (ref) => { durableRefs.push(ref); return row('inbox-uuid', 'INBOX', '<same@id>'); },
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

  // The failure is reported, but the assertions below are what prove the behaviour.
  const originalError = console.error;
  console.error = () => {};
  try {
    history.navigate('back');
    record(); // the recorder echo
    await tick();
  } finally {
    console.error = originalError;
  }

  // A 500 means "could not check", not "gone": swapping in the INBOX twin would be
  // worse than leaving the pane empty, so the durable lookup is never attempted.
  assert.deepEqual(durableRefs, []);
  assert.deepEqual(Object.values(useStore.getState().threadMessages).flat(), []);
  assert.equal(useStore.getState().selectedMessageId, 'archive-uuid');
});

test('a row that is gone with nothing durable to fall back on is left alone', async () => {
  resetStore();
  // A message without a Message-ID header stores its row id as the reference, so
  // there is nothing more to ask for once the exact lookup 404s.
  const { options, exactCalls, durableCalls } = lookups({ exact: () => null, durable: () => row('other') });
  const history = createAppViewHistory(options);
  const record = recorder(history);

  history.reset();
  useStore.setState({ messages: [row('gone-uuid')], selectedMessageId: 'gone-uuid' });
  record();
  useStore.getState().setSelectedAccount(null, 'Sent');
  record();

  history.navigate('back');
  record(); // the recorder echo
  await tick();

  assert.deepEqual(exactCalls, ['gone-uuid']);
  assert.deepEqual(durableCalls, []);
  assert.deepEqual(Object.values(useStore.getState().threadMessages).flat(), []);
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
