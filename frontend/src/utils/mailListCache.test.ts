import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMailListCache } from './mailListCache.ts';

const params = { limit: 50, offset: 0, threaded: 'true' };
const snapshot = (id = 'm', size = 1) => ({ messages: Array.from({ length: size }, (_, index) => ({ id: `${id}-${index}`, account_id: 'a' })), total: size });

describe('bounded navigation snapshots', () => {
  it('separates account, folder, filter, grouping, category and page-size scopes', () => {
    const cache = createMailListCache();
    const value = snapshot();
    cache.finish(cache.begin(params, 1), value);
    assert.equal(cache.get({ threaded: 'true', offset: 0, limit: 50 }, 1), value);
    for (const change of [{ accountId: 'a' }, { folder: 'Sent' }, { unreadOnly: 'true' }, { threaded: 'false' }, { category: 'social' }, { limit: 25 }, { offset: 50 }]) {
      assert.equal(cache.get({ ...params, ...change }, 1), undefined);
    }
  });
  it('expires old snapshots and rejects a clock moving backward', () => {
    let time = 100;
    const cache = createMailListCache({ now: () => time, maxAgeMs: 60 });
    cache.finish(cache.begin(params, 1), snapshot());
    time = 159; assert.ok(cache.get(params, 1));
    time = 160; assert.equal(cache.get(params, 1), undefined);
    cache.finish(cache.begin(params, 1), snapshot());
    time = 159; assert.equal(cache.get(params, 1), undefined);
  });
  it('caps entries with LRU eviction and caps retained row count', () => {
    const cache = createMailListCache({ maxEntries: 2, maxRows: 4 });
    const a = { ...params, accountId: 'a' }, b = { ...params, accountId: 'b' }, c = { ...params, accountId: 'c' };
    cache.finish(cache.begin(a, 1), snapshot('a', 2)); cache.finish(cache.begin(b, 1), snapshot('b', 2));
    assert.ok(cache.get(a, 1));
    cache.finish(cache.begin(c, 1), snapshot('c', 2));
    assert.equal(cache.get(b, 1), undefined); assert.ok(cache.get(a, 1));
    cache.finish(cache.begin(params, 1), snapshot('new', 4));
    assert.equal(cache.get(a, 1), undefined); assert.equal(cache.get(c, 1), undefined);
    assert.equal(cache.get(params, 1)?.messages.length, 4);
    assert.equal(cache.begin({ ...params, offset: 50 }, 1), undefined);
    assert.equal(cache.begin({ ...params, limit: 1000 }, 1), undefined);
  });
  it('never accepts an older request after a newer response for the same key', () => {
    const cache = createMailListCache();
    const old = cache.begin(params, 1), recent = cache.begin(params, 1);
    const value = snapshot('new');
    cache.finish(recent, value); cache.finish(old, snapshot('old'));
    assert.equal(cache.get(params, 1), value);
  });
  it('fences an in-flight response on local mutations or remote invalidations', () => {
    const cache = createMailListCache();
    cache.finish(cache.begin(params, 1), snapshot());
    const old = cache.begin(params, 1);
    cache.invalidate(); cache.finish(old, snapshot('stale'));
    assert.equal(cache.get(params, 1), undefined);
  });
  it('invalidates the affected account and unified view without evicting unrelated accounts', () => {
    const cache = createMailListCache();
    const a = { ...params, accountId: 'a' }, b = { ...params, accountId: 'b' };
    for (const query of [params, a, b]) cache.finish(cache.begin(query, 1), snapshot());
    cache.invalidate('a');
    assert.equal(cache.get(params, 1), undefined); assert.equal(cache.get(a, 1), undefined); assert.ok(cache.get(b, 1));
  });
  it('drops private data on epoch changes or lock and rejects late old-session responses', () => {
    const cache = createMailListCache();
    cache.finish(cache.begin(params, 1), snapshot('private'));
    const pending = cache.begin(params, 1);
    assert.equal(cache.get(params, 2), undefined);
    cache.finish(pending, snapshot('late-private'));
    assert.equal(cache.get(params, 2), undefined);
    const beforeLock = cache.begin(params, 2); cache.clear(); cache.finish(beforeLock, snapshot());
    assert.equal(cache.get(params, 2), undefined);
  });
  it('keeps a valid snapshot after a failed revalidation without extending its age', () => {
    let time = 0;
    const cache = createMailListCache({ now: () => time, maxAgeMs: 10 });
    const value = snapshot(); cache.finish(cache.begin(params, 1), value);
    time = 9; cache.finish(cache.begin(params, 1));
    assert.equal(cache.get(params, 1), value);
    time = 10; assert.equal(cache.get(params, 1), undefined);
  });
});

describe('account-scoped invalidation fences', () => {
  it('fences affected and unified requests while preserving unrelated in-flight snapshots', () => {
    const cache = createMailListCache();
    const a = { ...params, accountId: 'a' }, b = { ...params, accountId: 'b' }, c = { ...params, accountId: 'c' };
    const pending = [params, a, b, c].map(query => cache.begin(query, 1));
    cache.invalidate(['a', 'b', 'a']);
    pending.forEach(ticket => cache.finish(ticket, snapshot()));
    for (const query of [params, a, b]) assert.equal(cache.get(query, 1), undefined);
    assert.ok(cache.get(c, 1));
  });
  it('never permits a matching older request to overwrite a post-invalidation response', () => {
    const cache = createMailListCache();
    const a = { ...params, accountId: 'a' };
    const old = cache.begin(a, 1);
    cache.invalidate('a');
    const value = snapshot('fresh');
    cache.finish(cache.begin(a, 1), value);
    cache.finish(old, snapshot('stale'));
    assert.equal(cache.get(a, 1), value);
  });
});
