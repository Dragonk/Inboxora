import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queueReadStateMutation, resetReadStateMutationsForTest, pendingReadState } from './readStateMutation.ts';

describe('read-state mutation lane', () => {
  it('commits latest explicit intent after an older auto-read', async () => {
    resetReadStateMutationsForTest();
    const calls: unknown[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queueReadStateMutation('m2', true, read => new Promise<void>(resolve => {
      calls.push(read);
      releaseFirst = () => resolve();
    }));
    const second = queueReadStateMutation('m2', false, async read => { calls.push(read); });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [true]);
    assert.equal(pendingReadState('m2'), false);
    if (releaseFirst === undefined) throw new Error('first read-state mutation did not start');
    releaseFirst();
    await Promise.all([first.promise, second.promise]);
    assert.deepEqual(calls, [true, false]);
    assert.equal(pendingReadState('m2'), undefined);
  });

  it('ignores a superseded automatic failure while committing the newer intent', async () => {
    resetReadStateMutationsForTest();
    const calls: unknown[] = [];
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const first = queueReadStateMutation('m3', true, read => new Promise<void>((resolve, reject) => {
      calls.push(read);
      rejectFirst = reason => reject(reason);
    }));
    const second = queueReadStateMutation('m3', false, async read => { calls.push(read); });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (rejectFirst === undefined) throw new Error('first read-state mutation did not start');
    rejectFirst(new Error('automatic read failed'));
    await Promise.allSettled([first.promise, second.promise]);
    assert.deepEqual(calls, [true, false]);
    assert.equal(pendingReadState('m2'), undefined);
  });

  it('serializes reversed explicit responses as the latest read state', async () => {
    resetReadStateMutationsForTest();
    const calls: unknown[] = [];
    const unread = queueReadStateMutation('m1', false, async read => calls.push(read));
    const read = queueReadStateMutation('m1', true, async value => calls.push(value));
    await Promise.all([unread.promise, read.promise]);
    assert.deepEqual(calls, [false, true]);
  });
});
