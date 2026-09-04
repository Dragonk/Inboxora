import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulkUnreadDelta, failedBulkRow, failedBulkTargets } from './threadedBulkRollback.js';

describe('threaded bulk rollback', () => {
  it('reconciles a collapsed row to only failed physical copies', () => {
    const row = { id: 'copy-5', unread_count: 3, is_read: false, message_count: 5 };
    const targets = new Map([
      ['copy-1', { id: 'copy-1', is_read: false }],
      ['copy-2', { id: 'copy-2', is_read: false }],
      ['copy-3', { id: 'copy-3', is_read: false }],
      ['copy-4', { id: 'copy-4', is_read: true }],
      ['copy-5', { id: 'copy-5', is_read: false }],
    ]);
    const failedIds = new Set(['copy-2', 'copy-4']);
    assert.deepEqual(failedBulkTargets(targets, failedIds).map(message => message.id), ['copy-2', 'copy-4']);
    assert.deepEqual(failedBulkRow(row, targets, failedIds), {
      ...row, is_read: false, unread_count: 1, message_count: 2, copy_count: 2,
    });
  });

  it('falls back to singleton read state when aggregate count is absent', () => {
    assert.equal(bulkUnreadDelta({ is_read: false }), 1);
    assert.equal(bulkUnreadDelta({ is_read: true }), 0);
  });
});
