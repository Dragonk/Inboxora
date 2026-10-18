// New-mail notification parity for the Gmail sync, asserted against the source:
// only the incremental history feed carries the rows it created, only the
// INBOX label is a target, and a baseline (the mailbox's past) never notifies.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';

describe('Gmail new-mail notification parity', () => {
  it('collects the rows a thread projection created', async () => {
    const source = await readFile(new URL('./gmailMailSync.ts', import.meta.url), 'utf8');
    assert.match(source, /const totals = \{ created: 0, updated: 0, deleted: 0, skipped: 0, rowIds: \[\] as string\[\], insertedRowIds: \[\] as string\[\] \};/);
    assert.match(source, /totals\.insertedRowIds\.push\(applied\.id\);/);
  });

  it('emits the canonical event only for incremental INBOX arrivals', async () => {
    const source = await readFile(new URL('./gmailMailSync.ts', import.meta.url), 'utf8');
    assert.match(source, /if \(labelPath === 'INBOX' && notifyRowIds && notifyRowIds\.length > 0\) \{/);
    assert.match(source, /scheduleProviderMailNotifications\(\{ userId: input\.userId, rowIds: notifyRowIds \}\);/);
    // The incremental feed forwards the created rows...
    assert.match(source, /await afterIngest\(applied\.rowIds, 'INBOX', applied\.insertedRowIds\);/);
    assert.match(source, /\(rowIds, _labelPath, notifyRowIds\) => afterIngest\(rowIds, 'INBOX', notifyRowIds\)\);/);
    // ...and the baseline, which enumerates history, does not.
    const baselineCall = /await afterIngest\(applied\.rowIds, target\.folderPath\);/;
    assert.match(source, baselineCall);
  });
});
