import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createCoalescedTask } from './coalescedTask.ts';
import { createMailListCache } from './mailListCache.ts';

// Execute the real coordinator with store/HTTP boundaries replaced. No source-text
// assertion is used to stand in for behavior; the compiler is already a dev dependency.
const source = readFileSync(new URL('./mailRefresh.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Methods = { requestMailRefresh: (id?: string) => void; cancelMailRefresh: () => void; noteMailListLoaded: () => void; mailListNeedsRefresh: (age?: number) => boolean };
function harness(getFolders: (id: string) => Promise<Array<{ path: string }>> = async () => [{ path: 'INBOX' }]) {
  const cache = createMailListCache();
  const events: string[] = []; const writes: string[] = [];
  let counts = 0; let invalidated = 0; let now = 100_000;
  const state = {
    user: { id: 'user-A' }, authEpoch: 1, isLocked: false, selectedAccountId: 'A' as string | null,
    selectedFolder: 'INBOX', searchQuery: '', messagesRefreshToken: 0, showContacts: false, showCalendar: false,
    accounts: [{ id: 'A', include_in_unified_inbox: true }, { id: 'B', include_in_unified_inbox: false }],
    folders: { A: [], B: [] },
    setFolders: (id: string, rows: Array<{ path: string }>) => { writes.push(`${id}:${rows[0]?.path}`); },
  };
  const context = { exports: {}, setTimeout, clearTimeout, Date: { now: () => now },
    window: { dispatchEvent: (event: { type: string }) => { events.push(event.type); } },
    CustomEvent: class { constructor(public type: string) {} },
    require: (name: string) => {
      if (name === './mailListCache.ts') return { invalidateMailListCache: (id?: string) => cache.invalidate(id) };
      if (name === './api.ts') return { api: { getFolders } };
      if (name === '../store/index.ts') return { useStore: { getState: () => state } };
      if (name === './coalescedTask.ts') return { createCoalescedTask };
      if (name === './diagEvents.ts') return { recordDiagEvent: () => {} };
      if (name === './unreadRefresh.ts') return {
        refreshUnreadCounts: async () => { counts += 1; }, invalidateUnreadCountRequests: () => { invalidated += 1; },
      };
      if (name === './unifiedInbox.ts') return { accountAffectsUnifiedInbox: (_accounts: unknown, id: string) => id === 'A' };
      throw new Error(`Unexpected coordinator dependency ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  return { cache, methods: context.exports as Methods, state, events, writes, counts: () => counts,
    invalidated: () => invalidated, advance: (ms: number) => { now += ms; } };
}

test('an unrelated/opted-out account refreshes counters without resetting the visible list', async () => {
  const h = harness(); h.state.selectedAccountId = null;
  try {
    h.methods.requestMailRefresh('B'); await wait(330);
    assert.deepEqual(h.events, []); assert.equal(h.counts(), 1);
    assert.deepEqual(h.writes, ['B:INBOX']);
  } finally { h.methods.cancelMailRefresh(); }
});
test('a burst produces one scoped list invalidation and one count refresh', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 100; i += 1) h.methods.requestMailRefresh('A');
    await wait(330);
    assert.deepEqual(h.events, ['inboxora:refresh', 'inboxora:sync_done']); assert.equal(h.counts(), 1);
  } finally { h.methods.cancelMailRefresh(); }
});
test('lock/unmount fences an old folder response even when authEpoch stays the same', async () => {
  let release: (value: Array<{ path: string }>) => void = () => {};
  const gate = new Promise<Array<{ path: string }>>(resolve => { release = resolve; });
  const h = harness(async () => gate);
  try {
    h.methods.requestMailRefresh('A'); await wait(330);
    h.methods.cancelMailRefresh();
    // Same-user unlock does not make the abandoned operation current again.
    h.state.isLocked = false; release([{ path: 'STALE' }]); await wait(20);
    assert.deepEqual(h.writes, []); assert.ok(h.invalidated() >= 1);
  } finally { release([]); h.methods.cancelMailRefresh(); }
});
test('an old-session response cannot populate a new user session', async () => {
  let release: (value: Array<{ path: string }>) => void = () => {};
  const gate = new Promise<Array<{ path: string }>>(resolve => { release = resolve; });
  const h = harness(async () => gate);
  try {
    h.methods.requestMailRefresh('A'); await wait(330);
    h.state.authEpoch += 1; h.state.user = { id: 'user-B' };
    release([{ path: 'USER_A_FOLDER' }]); await wait(20);
    assert.deepEqual(h.writes, []);
  } finally { release([]); h.methods.cancelMailRefresh(); }
});
test('freshness is measured from a successful view read, not WebSocket liveness', () => {
  const h = harness();
  try {
    assert.equal(h.methods.mailListNeedsRefresh(), true);
    h.methods.noteMailListLoaded(); h.advance(49_999);
    assert.equal(h.methods.mailListNeedsRefresh(), false);
    h.advance(1); assert.equal(h.methods.mailListNeedsRefresh(), true);
    h.methods.noteMailListLoaded(); h.state.selectedAccountId = 'B';
    assert.equal(h.methods.mailListNeedsRefresh(), true);
  } finally { h.methods.cancelMailRefresh(); }
});


test('remote account hints evict warm snapshots immediately, before the refresh debounce', () => {
  const h = harness();
  try {
    // Bootstrap the coordinator, then cache data obtained during this session.
    h.methods.requestMailRefresh('A');
    const unified = { limit: 50, offset: 0 };
    const account = { ...unified, accountId: 'A' };
    const other = { ...unified, accountId: 'B' };
    const snapshot = { messages: [{ id: 'm', account_id: 'A' }], total: 1 };
    for (const params of [unified, account, other]) h.cache.finish(h.cache.begin(params, 1), snapshot);
    const pending = h.cache.begin(account, 1);
    h.methods.requestMailRefresh('A');
    h.cache.finish(pending, snapshot);
    assert.equal(h.cache.get(unified, 1), undefined);
    assert.equal(h.cache.get(account, 1), undefined);
    assert.ok(h.cache.get(other, 1));
    h.methods.cancelMailRefresh();
    assert.equal(h.cache.get(other, 1), undefined);
  } finally { h.methods.cancelMailRefresh(); }
});
