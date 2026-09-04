import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queueReadStateMutation, resetReadStateMutationsForTest } from './readStateMutation.js';

describe('read-state mutation lane', () => {
  it('commits latest explicit intent after an older auto-read', async () => {
    resetReadStateMutationsForTest();
    const calls = [];
    let release;
    const first = queueReadStateMutation('m2', true, read => new Promise(resolve => {
      calls.push(read); release = resolve;
    }));
    const second = queueReadStateMutation('m2', false, async read => { calls.push(read); });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [true]);
    release();
    await Promise.all([first.promise, second.promise]);
    assert.deepEqual(calls, [true, false]);
  });

  it('ignores a superseded automatic failure while committing the newer intent', async () => {
    resetReadStateMutationsForTest();
    const calls = [];
    let rejectFirst;
    const first = queueReadStateMutation('m3', true, read => new Promise((resolve, reject) => {
      calls.push(read);
      rejectFirst = reject;
    }));
    const second = queueReadStateMutation('m3', false, async read => { calls.push(read); });
    await new Promise(resolve => setTimeout(resolve, 0));
    rejectFirst(new Error('automatic read failed'));
    await Promise.allSettled([first.promise, second.promise]);
    assert.deepEqual(calls, [true, false]);
  });

  it('serializes reversed explicit responses as the latest read state', async () => {
    resetReadStateMutationsForTest();
    const calls = [];
    const unread = queueReadStateMutation('m1', false, async read => calls.push(read));
    const read = queueReadStateMutation('m1', true, async value => calls.push(value));
    await Promise.all([unread.promise, read.promise]);
    assert.deepEqual(calls, [false, true]);
  });
});
