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
    const accountId = new URL(String(_input), 'http://fixture.test').searchParams.get('accountId') || 'a';
    return json(init?.method === 'POST' ? { ok: true } : { messages: [{ id: `m-${accountId}`, account_id: accountId }], total: 1 });
  };
  const scopes = [params, ...['a', 'b', 'c'].map(accountId => ({ ...params, accountId }))];
  for (const scope of scopes) await api.getMessages(scope);
  await api.bulkRead(['a-1', 'b-1'], true, ['a', 'b', 'a']);
  for (const scope of scopes.slice(0, 3)) assert.equal(api.getCachedMessages(scope), undefined);
  assert.equal(api.getCachedMessages(scopes[3])?.messages[0]?.account_id, 'c');
  assert.deepEqual(sent, { ids: ['a-1', 'b-1'], read: true });
});

test('missing, empty or incomplete bulk-read scope retains global invalidation', async () => {
  globalThis.fetch = async () => json({ messages: [{ id: 'other-row', account_id: 'other' }], total: 1 });
  const other = { ...params, accountId: 'other' };
  for (const hint of [undefined, [], ['a', undefined], ['a', ''], ['a', null], ['a', 0], [' a ']]) {
    await api.getMessages(other);
    await api.bulkRead(['a-1', 'unknown-id'], true, hint);
    assert.equal(api.getCachedMessages(other), undefined);
  }
});

for (const outcome of ['success', 'http-error', 'network-error']) {
  test(`mail write completion fences overlapping cached results and pending tickets on ${outcome}`, async () => {
    setAuthEpoch(300);
    const scopes = [params, { ...params, accountId: 'a' }, { ...params, accountId: 'c' }];
    let finish: (response: Response) => void = () => { throw new Error('write not started'); };
    let fail: (error: Error) => void = () => { throw new Error('write not started'); };
    globalThis.fetch = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const write = api.bulkRead(['m'], true, ['a']);
    const result = write.then(() => 'success', () => 'failure');
    // A GET which starts after pre-write eviction can observe the old DB state.
    for (const scope of scopes) {
      const accountId = 'accountId' in scope ? scope.accountId : 'a';
      mailListCache.finish(mailListCache.begin(scope, 300), { messages: [{ id: `${accountId}-old`, account_id: accountId }], total: 1 });
    }
    const pending = scopes.map(scope => ({ scope, ticket: mailListCache.begin(scope, 300) }));
    if (outcome === 'network-error') fail(new Error('Connection lost after send'));
    else finish(outcome === 'success' ? json({ ok: true }) : new Response(JSON.stringify({ error: 'Rejected' }), { status: 500 }));
    assert.equal(await result, outcome === 'success' ? 'success' : 'failure');
    for (const scope of scopes.slice(0, 2)) assert.equal(api.getCachedMessages(scope), undefined);
    for (const { scope, ticket } of pending) {
      const accountId = 'accountId' in scope ? scope.accountId : 'a';
      mailListCache.finish(ticket, { messages: [{ id: `${accountId}-late`, account_id: accountId }], total: 1 });
    }
    for (const scope of scopes.slice(0, 2)) assert.equal(api.getCachedMessages(scope), undefined);
    assert.equal(api.getCachedMessages(scopes[2])?.messages[0]?.account_id, 'c');
  });
}

test('old-session write completion does not evict new-session navigation snapshots', async () => {
  setAuthEpoch(400);
  let finish: (response: Response) => void = () => { throw new Error('write not started'); };
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const oldWrite = api.bulkRead(['m'], true, ['a']);
  setAuthEpoch(401);
  mailListCache.finish(mailListCache.begin(params, 401), data);
  finish(json({ ok: true })); await oldWrite;
  assert.deepEqual(api.getCachedMessages(params), data);
});
