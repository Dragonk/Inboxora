// Run with: node --test src/aiResults.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
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
  afterEach(() => localStorage.clear());

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

  describe('getResults', () => {
    it('returns the correct results when the store is populated via localStorage mock', () => {
      const mockState = {
        order: ['m1', 'm2'],
        data: {
          m1: {
            summarize: { text: 'summary 1', at: 1000, label: 'Summary' }
          },
          m2: {
            translate: { text: 'translation 2', at: 2000, label: 'Translate' }
          }
        }
      };
      localStorage.setItem('mailflow_ai_results', JSON.stringify(mockState));

      const r1 = getResults('m1');
      assert.deepEqual(r1, mockState.data.m1);

      const r2 = getResults('m2');
      assert.deepEqual(r2, mockState.data.m2);
    });

    it('returns an empty object when the requested messageId is not in the mocked store data', () => {
      const mockState = {
        order: ['m1'],
        data: {
          m1: {
            summarize: { text: 'summary 1', at: 1000 }
          }
        }
      };
      localStorage.setItem('mailflow_ai_results', JSON.stringify(mockState));

      const r = getResults('missing');
      assert.deepEqual(r, {});
    });

    it('returns an empty object for unknown or missing message ids', () => {
      assert.deepEqual(getResults('nope'), {});
      assert.deepEqual(getResults(null), {});
      assert.deepEqual(getResults(undefined), {});
    });

    it('returns empty object when messageId is omitted', () => {
      assert.deepEqual(getResults(), {});
    });

    it('returns empty object when localStorage has invalid JSON', () => {
      localStorage.setItem('mailflow_ai_results', '{ bad json');
      assert.deepEqual(getResults('m1'), {});
    });

    it('returns empty object when localStorage has valid JSON but missing data field', () => {
      localStorage.setItem('mailflow_ai_results', '{"order": ["m1"]}');
      assert.deepEqual(getResults('m1'), {});
    });

    it('returns empty object when localStorage has valid JSON that is not an object', () => {
      localStorage.setItem('mailflow_ai_results', '["m1"]');
      assert.deepEqual(getResults('m1'), {});
    });

    it('returns object from data field when order is not an array', () => {
      localStorage.setItem('mailflow_ai_results', '{"order": "invalid", "data": {"m1": {"summarize": {"text": "A", "at": 123}}}}');
      const r = getResults('m1');
      assert.equal(r.summarize.text, 'A');
      assert.equal(r.summarize.at, 123);
    });
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

  it('does nothing when saveResult is called with null or undefined messageId or actionKey', () => {
    saveResult(null, 'summarize', 'A');
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
    saveResult('m1', null, 'A');
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
    saveResult(undefined, undefined, 'A');
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
  });

  it('does nothing when removeResult is called with invalid or non-existent arguments', () => {
    removeResult(null, 'summarize');
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
    removeResult('m1', null);
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
    removeResult('nope', 'summarize');
    assert.equal(localStorage.getItem('mailflow_ai_results'), null);
    saveResult('m1', 'summarize', 'A');
    const storeAfterSave = localStorage.getItem('mailflow_ai_results');
    removeResult('m1', 'non_existent');
    assert.equal(localStorage.getItem('mailflow_ai_results'), storeAfterSave);
  });

  it('fails gracefully when localStorage throws an error on write', () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    try {
      assert.doesNotThrow(() => {
        saveResult('fail_msg', 'summarize', 'will fail to save');
      });
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });

  it('logs a warning when localStorage throws an error on write', () => {
    const originalSetItem = localStorage.setItem;
    const originalWarn = console.warn;
    let warnCalledWith: any[] | null = null;
    let warnCount = 0;

    console.warn = (...args) => {
      warnCount++;
      warnCalledWith = args;
    };

    const fakeError = new Error('Quota exceeded');
    localStorage.setItem = () => { throw fakeError; };

    try {
      saveResult('fail_msg', 'summarize', 'will fail to save');
      assert.equal(warnCount, 1);
      assert.equal(warnCalledWith![0], 'Failed to save AI results to localStorage');
      assert.equal(warnCalledWith![1], fakeError);
    } finally {
      localStorage.setItem = originalSetItem;
      console.warn = originalWarn;
    }
  });

});
