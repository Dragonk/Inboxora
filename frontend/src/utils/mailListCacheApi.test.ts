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
