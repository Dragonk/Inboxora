import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreadCacheField, mergeThreadReadSnapshot } from './threadCacheState.ts';

describe('thread cache field merges', () => {
  it('updates only the owned field on every physical copy', () => {
    const cached = [
      { id: 'copy-1', is_read: false, is_starred: true },
      { id: 'copy-2', is_read: true, is_starred: false },
    ];

    assert.deepEqual(mergeThreadCacheField(cached, 'is_read', true), [
      { id: 'copy-1', is_read: true, is_starred: true },
      { id: 'copy-2', is_read: true, is_starred: false },
    ]);
    assert.deepEqual(mergeThreadCacheField(cached, 'is_starred', true), [
      { id: 'copy-1', is_read: false, is_starred: true },
      { id: 'copy-2', is_read: true, is_starred: true },
    ]);
  });
});


describe('read action membership snapshots', () => {
  it('includes new replies, drops removed copies, and preserves independent cached fields', () => {
    const cached = [
      { id: 'old', is_read: false, is_starred: false },
      { id: 'kept', is_read: false, is_starred: true },
    ];
    const resolved = [
      { id: 'kept', is_read: false, is_starred: false },
      { id: 'new', is_read: false, is_starred: false },
    ];
    assert.deepEqual(mergeThreadReadSnapshot(cached, resolved, true), [
      { id: 'kept', is_read: true, is_starred: true },
      { id: 'new', is_read: true, is_starred: false },
    ]);
    assert.equal(cached[0].is_read, false);
    assert.equal(resolved[0].is_read, false);
  });
  it('hydrates an uncached thread for mark unread as well as mark read', () => {
    assert.deepEqual(mergeThreadReadSnapshot(undefined, [{ id: 'new', is_read: true }], false), [{ id: 'new', is_read: false }]);
  });
});
