import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { finishSyncRun } from './syncCoordinator.js';

describe('finishSyncRun', () => {
  it('clears the historical failure timestamp when a clean run completes', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'state-1' }], rowCount: 1 });
    const client = { query } as unknown as PoolClient;

    await expect(finishSyncRun(client, {
      syncStateId: 'state-1', generation: 4, lastErrorCode: null,
    })).resolves.toBe(true);

    const [statement, params] = query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain('last_error_at = CASE WHEN $3::text IS NULL THEN NULL ELSE last_error_at END');
    expect(params).toEqual(['state-1', 4, null]);
  });

  it('keeps the failure timestamp when a completed run reports a partial error', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'state-1' }], rowCount: 1 });
    const client = { query } as unknown as PoolClient;

    await finishSyncRun(client, {
      syncStateId: 'state-1', generation: 5, lastErrorCode: 'PARTIAL_SYNC',
    });

    const [statement, params] = query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain('last_error_at = CASE WHEN $3::text IS NULL THEN NULL ELSE last_error_at END');
    expect(params).toEqual(['state-1', 5, 'PARTIAL_SYNC']);
  });
});
