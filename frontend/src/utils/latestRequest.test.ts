import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequest } from './latestRequest.ts';

describe('createLatestRequest', () => {
  it('ignores an older response that finishes after a newer response', async () => {
    const pending: ((value: string) => void)[] = [];
    const request = () => new Promise<string>(resolve => pending.push(resolve));
    const applied: string[] = [];
    const latest = createLatestRequest();

    const older = latest.run(request, (value: string) => applied.push(value));
    const newer = latest.run(request, (value: string) => applied.push(value));

    pending[1]('new inbox');
    await newer;
    pending[0]('stale inbox');
    await older;

    assert.deepEqual(applied, ['new inbox']);
  });

  it('ignores an in-flight response after optimistic state invalidates it', async () => {
    const pending: ((value: string) => void)[] = [];
    const latest = createLatestRequest();
    const applied: string[] = [];
    const inFlight = latest.run(
      () => new Promise<string>(resolve => pending.push(resolve)),
      (value: string) => applied.push(value),
    );

    latest.invalidate();
    pending[0]('snapshot from before archive');
    await inFlight;

    assert.deepEqual(applied, []);
  });
});
