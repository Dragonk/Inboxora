// Run with: node --test src/aiResults.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub (aiResults only touches it inside its functions).
Reflect.set(globalThis, 'localStorage', (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => (key in store ? store[key] : null),
    setItem: (key: string, value: string): void => { store[key] = value; },
    removeItem: (key: string): void => { delete store[key]; },
    clear: (): void => { store = {}; },
  };
})());

const { getResults, saveResult, removeResult } = await import('./aiResults.ts');

describe('aiResults', () => {
  beforeEach(() => localStorage.clear());

  it('saves and reads back a result with text and label', () => {
    saveResult('m1', 'summarize', 'the summary', 'Summary');
    const r = getResults('m1');
    assert.equal(r.summarize.text, 'the summary');
    assert.equal(r.summarize.label, 'Summary');
    assert.equal(typeof r.summarize.at, 'number');
  });

  it('keeps multiple action results per message independent', () => {
    saveResult('m1', 'summarize', 'A', 'Summary');
    saveResult('m1', 'act-2', 'B', 'Translate');
    const r = getResults('m1');
    assert.equal(r.summarize.text, 'A');
    assert.equal(r['act-2'].text, 'B');
  });

  it('removes one action but keeps the others', () => {
    saveResult('m1', 'summarize', 'A');
    saveResult('m1', 'act-2', 'B');
    removeResult('m1', 'summarize');
    const r = getResults('m1');
    assert.equal(r.summarize, undefined);
    assert.equal(r['act-2'].text, 'B');
  });

  it('drops the message entry once its last result is removed', () => {
    saveResult('m1', 'summarize', 'A');
    removeResult('m1', 'summarize');
    assert.deepEqual(getResults('m1'), {});
  });

  it('returns an empty object for unknown or missing message ids', () => {
    assert.deepEqual(getResults('nope'), {});
    assert.deepEqual(getResults(null), {});
    assert.deepEqual(getResults(undefined), {});
  });

  it('evicts the oldest messages beyond the LRU cap', () => {
    // Cap is 200 messages; write 205 and confirm the earliest are gone.
    for (let i = 0; i < 205; i++) saveResult('msg-' + i, 'summarize', 'x' + i);
    assert.deepEqual(getResults('msg-0'), {}, 'oldest should be evicted');
    assert.deepEqual(getResults('msg-4'), {}, 'oldest should be evicted');
    assert.equal(getResults('msg-204').summarize.text, 'x204', 'newest should remain');
  });

  it('re-saving a message refreshes its recency so it survives eviction', () => {
    saveResult('keep', 'summarize', 'first');
    for (let i = 0; i < 199; i++) saveResult('bulk-' + i, 'summarize', 'y');
    saveResult('keep', 'summarize', 'refreshed'); // bump recency to newest
    for (let i = 0; i < 50; i++) saveResult('more-' + i, 'summarize', 'z');
    assert.equal(getResults('keep').summarize.text, 'refreshed', 'refreshed message should survive');
  });
});
