import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api } from './api.ts';
import { setAuthEpoch } from './authEpoch.ts';
import { mailListCache } from './mailListCache.ts';

const originalFetch = globalThis.fetch;
const params = { limit: 50, offset: 0 };
const data = { messages: [{ id: 'm', account_id: 'a' }], total: 1 };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { globalThis.fetch = originalFetch; mailListCache.clear(); });

test('navigation revalidates even when a snapshot exists', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return json(data); };
  await api.getMessages(params);
  assert.deepEqual(api.getCachedMessages(params), data);
  await api.getMessages(params);
  assert.equal(requests, 2);
});

test('mail writes evict snapshots before awaiting the network', async () => {
  globalThis.fetch = async () => json(data);
  await api.getMessages(params);
  let finish: (response: Response) => void = () => { throw new Error('write not started'); };
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const write = api.bulkRead(['m'], true);
  assert.equal(api.getCachedMessages(params), undefined);
  finish(json({ ok: true })); await write;
});

test('aborted navigation and late old-session responses cannot populate snapshots', async () => {
  let finish: (response: Response) => void = () => { throw new Error('request not started'); };
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const old = api.getMessages(params, { signal: controller.signal });
  controller.abort(); finish(json(data)); await old;
  assert.equal(api.getCachedMessages(params), undefined);
  setAuthEpoch(200);
  const previousSession = api.getMessages(params);
  setAuthEpoch(201); finish(json(data)); await previousSession;
  assert.equal(api.getCachedMessages(params), undefined);
});

test('body access bookkeeping does not evict unrelated navigation data', async () => {
  globalThis.fetch = async () => json(data);
  await api.getMessages(params); await api.touchMessageBody('m');
  assert.deepEqual(api.getCachedMessages(params), data);
});

test('bulk read scopes invalidation to all target accounts and keeps the wire payload unchanged', async () => {
  let sent: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') sent = JSON.parse(String(init.body));
    return json(init?.method === 'POST' ? { ok: true } : data);
  };
  const scopes = [params, ...['a', 'b', 'c'].map(accountId => ({ ...params, accountId }))];
  for (const scope of scopes) await api.getMessages(scope);
  await api.bulkRead(['a-1', 'b-1'], true, ['a', 'b', 'a']);
  for (const scope of scopes.slice(0, 3)) assert.equal(api.getCachedMessages(scope), undefined);
  assert.ok(api.getCachedMessages(scopes[3]));
  assert.deepEqual(sent, { ids: ['a-1', 'b-1'], read: true });
});

test('missing, empty or incomplete bulk-read scope retains global invalidation', async () => {
  globalThis.fetch = async () => json(data);
  const other = { ...params, accountId: 'other' };
  for (const hint of [undefined, [], ['a', undefined], ['a', ''], ['a', null], ['a', 0], [' a ']]) {
    await api.getMessages(other);
    await api.bulkRead(['a-1', 'unknown-id'], true, hint);
    assert.equal(api.getCachedMessages(other), undefined);
  }
});
