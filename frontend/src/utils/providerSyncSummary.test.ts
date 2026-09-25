import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerConnectorSummary } from './providerSyncSummary.ts';

const options = {
  id: (row: { id: string }) => row.id,
  count: (row: { id: string; count?: number }) => row.count ?? 0,
  failureKey: () => 'fallback.lastSyncFailed',
};
const summarize = (rows: Array<{ id: string; count?: number; lastSyncedAt?: string | null; lastErrorCode?: string | null; lastErrorAt?: string | null }>) =>
  providerConnectorSummary(rows, options);

describe('providerConnectorSummary', () => {
  it('reports the freshest sync and the total across collections', () => {
    const summary = summarize([
      { id: 'a', count: 10, lastSyncedAt: '2026-09-14T09:00:00.000Z' },
      { id: 'b', count: 5, lastSyncedAt: '2026-09-14T10:00:00.000Z' },
    ]);
    assert.equal(summary?.key, null);
    assert.equal(summary?.values.count, '15');
    assert.ok(summary?.values.date.includes(new Date('2026-09-14T10:00:00.000Z').getFullYear().toString()));
  });

  it('does not inflate the total when the status query fans out one collection', () => {
    // The unique key on sync_states includes `coverage`, so a second row per collection
    // is permitted by the schema; the number the line shows must not depend on that.
    const summary = summarize([
      { id: 'a', count: 10, lastSyncedAt: '2026-09-14T09:00:00.000Z' },
      { id: 'a', count: 10, lastSyncedAt: '2026-09-14T09:00:00.000Z' },
    ]);
    assert.equal(summary?.values.count, '10');
  });

  it('prefers a recorded failure over a success time, and carries when it happened', () => {
    const summary = summarize([
      { id: 'a', count: 10, lastSyncedAt: '2026-09-14T10:00:00.000Z' },
      { id: 'b', lastErrorCode: 'RATE_LIMITED', lastErrorAt: '2026-09-14T11:00:00.000Z' },
    ]);
    assert.equal(summary?.key, 'fallback.lastSyncFailed');
    assert.equal(summary?.values.code, 'RATE_LIMITED');
    assert.notEqual(summary?.values.when, '');
  });

  it('leaves the time empty rather than inventing one when the payload omits it', () => {
    const summary = summarize([{ id: 'a', lastErrorCode: 'INTERNAL_ERROR', lastErrorAt: null }]);
    assert.equal(summary?.values.when, '');
  });

  it('has nothing to say before any run, or with no payload', () => {
    for (const rows of [[], null, undefined, [{ id: 'a', count: 3 }]]) {
      assert.equal(summarize(rows as never), null);
    }
  });
});
