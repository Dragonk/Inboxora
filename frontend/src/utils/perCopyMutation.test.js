import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  queuePerCopyMutation,
  isLatestPerCopyMutation,
  resetPerCopyMutationsForTest,
} from './perCopyMutation.js';

afterEach(() => resetPerCopyMutationsForTest());

describe('per-copy mutation versions', () => {
  it('only the newest intent for one copy is current', async () => {
    const first = queuePerCopyMutation('copy-1', () => 'first');
    const second = queuePerCopyMutation('copy-1', () => 'second');
    const other = queuePerCopyMutation('copy-2', () => 'other');

    assert.equal(await first.promise, 'first');
    assert.equal(await second.promise, 'second');
    assert.equal(await other.promise, 'other');
    assert.equal(isLatestPerCopyMutation('copy-1', first.version), false);
    assert.equal(isLatestPerCopyMutation('copy-1', second.version), true);
    assert.equal(isLatestPerCopyMutation('copy-2', other.version), true);
  });
});
