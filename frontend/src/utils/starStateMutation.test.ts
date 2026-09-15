import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isLatestStarStateMutation,
  queueStarStateMutation,
  resetStarStateMutationsForTest,
} from './starStateMutation.ts';

describe('star-state mutation lane', () => {
  it('serializes opposite intents so the newest provider write is last', async () => {
    resetStarStateMutationsForTest();
    const calls: unknown[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const request = (starred: boolean) => {
      calls.push(starred);
      if (calls.length === 1) return firstGate;
      return Promise.resolve();
    };

    const first = queueStarStateMutation('copy-1', true, request);
    const second = queueStarStateMutation('copy-1', false, request);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, [true]);
    if (releaseFirst === undefined) throw new Error('First request resolver was not initialized');
    releaseFirst();
    await Promise.all([first.promise, second.promise]);

    assert.deepEqual(calls, [true, false]);
    assert.equal(isLatestStarStateMutation('copy-1', first.version), false);
    assert.equal(isLatestStarStateMutation('copy-1', second.version), true);
  });

  it('keeps independent physical copies in independent lanes', async () => {
    resetStarStateMutationsForTest();
    const calls: unknown[] = [];
    const first = queueStarStateMutation('copy-1', true, async value => { calls.push(['copy-1', value]); });
    const second = queueStarStateMutation('copy-2', true, async value => { calls.push(['copy-2', value]); });
    await Promise.all([first.promise, second.promise]);
    assert.deepEqual(calls, [['copy-1', true], ['copy-2', true]]);
  });
});
