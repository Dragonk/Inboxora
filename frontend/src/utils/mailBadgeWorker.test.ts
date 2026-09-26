import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/mail-badge.js', import.meta.url), 'utf8');
type PrefEvent = { data: { type: string; enabled: boolean }; source: { url: string }; waitUntil: (work: Promise<unknown>) => void };
function harness(fetchCount: () => Promise<{ total?: number; status?: number }> = async () => ({ total: 4 }), supported = true) {
  const writes: number[] = [];
  const saved = new Map<string, boolean>();
  const listeners: Array<(event: PrefEvent) => void> = [];
  const self: {
    navigator: { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    location: { origin: string };
    addEventListener: (kind: string, handler: (event: PrefEvent) => void) => void;
    inboxoraRefreshBadge?: (ignored?: unknown) => Promise<unknown>;
  } = {
    navigator: supported ? {
      setAppBadge: async n => { writes.push(n); }, clearAppBadge: async () => { writes.push(0); },
    } : {},
    location: { origin: 'https://mail.example.test' },
    addEventListener: (kind, handler) => { if (kind === 'message') listeners.push(handler); },
  };
  const db = {
    objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {},
    transaction: () => {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => {
        get: (key: string) => { result: boolean | undefined }; put: (value: boolean, key: string) => { result: boolean };
      } } = { objectStore: () => ({
        get: key => { const result = { result: saved.get(key) }; queueMicrotask(() => tx.oncomplete?.()); return result; },
        put: (value, key) => { saved.set(key, value); queueMicrotask(() => tx.oncomplete?.()); return { result: value }; },
      }) };
      return tx;
    },
  };
  const indexedDB = { open: () => {
    const req: { result: typeof db; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void } = { result: db };
    queueMicrotask(() => req.onsuccess?.()); return req;
  } };
  vm.runInNewContext(source, { self, indexedDB, setTimeout, clearTimeout, AbortController, URL, Promise,
    fetch: async (path: string, options: { credentials: string; cache: string }) => {
      assert.equal(path, '/api/mail/unread-counts');
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
      const state = await fetchCount(); const status = state.status ?? 200;
      return { status, ok: status >= 200 && status < 300, json: async () => ({ total: state.total }) };
    },
  });
  return {
    writes, saved,
    refresh: () => self.inboxoraRefreshBadge?.({ unreadCount: 99999 }),
    send: async (enabled: boolean, origin = 'https://mail.example.test/app') => {
      const work: Promise<unknown>[] = [];
      for (const listener of listeners) listener({ data: { type: 'inboxora_badge_preferences', enabled }, source: { url: origin }, waitUntil: promise => work.push(promise) });
      await Promise.all(work);
    },
  };
}

test('worker gets authoritative counts, ignores stale payload counts, and honors disabled indicators', async () => {
  let count = 4;
  const worker = harness(async () => ({ total: count }));
  await worker.send(true); assert.equal(worker.writes.at(-1), 4);
  count = 1; await worker.refresh(); assert.equal(worker.writes.at(-1), 1);
  await worker.send(false); assert.equal(worker.writes.at(-1), 0);
  assert.equal(worker.saved.get('badge_enabled'), false);
});
test('a disabled preference fences an earlier in-flight unread request', async () => {
  let release: (value: { total: number }) => void = () => {};
  let requested = false;
  const gate = new Promise<{ total: number }>(resolve => { release = resolve; });
  const worker = harness(async () => { requested = true; return gate; });
  const old = worker.send(true);
  while (!requested) await new Promise(resolve => setTimeout(resolve, 1));
  const latest = worker.send(false);
  release({ total: 9 }); await Promise.all([old, latest]);
  assert.equal(worker.writes.at(-1), 0);
  assert.ok(!worker.writes.includes(9));
});
test('failed count reads retain the badge while unauthorized sessions clear it', async () => {
  let state: { total?: number; status?: number } = { total: 3 };
  const worker = harness(async () => state);
  await worker.send(true);
  state = { status: 503 }; await worker.refresh(); assert.equal(worker.writes.at(-1), 3);
  state = { status: 401 }; await worker.refresh(); assert.equal(worker.writes.at(-1), 0);
});
test('unsupported Badging API and unrelated message origins do not throw', async () => {
  const worker = harness(async () => ({ total: 8 }), false);
  await worker.send(true, 'https://unrelated.example/'); assert.equal(worker.saved.size, 0);
  await worker.send(true); await worker.refresh(); assert.deepEqual(worker.writes, []);
});
