import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  queuePerCopyMutation,
  isLatestPerCopyMutation,
  invalidatePerCopyMutation,
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

  it('invalidates an in-flight intent without affecting another copy', () => {
    const pending = queuePerCopyMutation('copy-1', () => undefined);
    const other = queuePerCopyMutation('copy-2', () => undefined);

    invalidatePerCopyMutation('copy-1', pending.version);

    assert.equal(isLatestPerCopyMutation('copy-1', pending.version), false);
    assert.equal(isLatestPerCopyMutation('copy-2', other.version), true);
  });

  it('keeps freshness isolated between semantic action lanes', () => {
    const read = queuePerCopyMutation('copy-1', 'read', () => undefined);
    const star = queuePerCopyMutation('copy-1', 'star', () => undefined);

    assert.equal(isLatestPerCopyMutation('copy-1', 'read', read.version), true);
    assert.equal(isLatestPerCopyMutation('copy-1', 'star', star.version), true);
  });

  it('invalidates only the latest intent in the same lane', () => {
    const first = queuePerCopyMutation('copy-1', 'read', () => undefined);
    const second = queuePerCopyMutation('copy-1', 'read', () => undefined);
    const star = queuePerCopyMutation('copy-1', 'star', () => undefined);

    assert.equal(isLatestPerCopyMutation('copy-1', 'read', first.version), false);
    assert.equal(isLatestPerCopyMutation('copy-1', 'read', second.version), true);
    assert.equal(isLatestPerCopyMutation('copy-1', 'star', star.version), true);
  });
});
