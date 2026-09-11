import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreadCacheField } from './threadCacheState.js';

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
